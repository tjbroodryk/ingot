import { jsonSchema } from '@ai-sdk/provider-utils';
import {
  generateText,
  hasToolCall,
  stepCountIs,
  tool,
  type JSONValue,
  type LanguageModel,
  type ToolSet,
} from 'ai';
import type { MemoryAdapter } from '../adapters/types.js';
import type { Question } from '../questions/questions.js';

/**
 * The agent under test.
 *
 * One loop, used for every adapter and every provider, with only the tool list
 * differing. That is the whole fairness argument in one file: same model, same
 * system prompt skeleton, same budget, same answer channel. If two columns
 * differ, the tools are the only thing that could have caused it.
 *
 * The AI SDK owns the transcript, so Claude's Messages API and the
 * OpenAI-shaped Chat Completions that Foundry serves for GPT deployments run
 * the identical control flow rather than two loops that have to be argued as
 * equivalent.
 */

export interface AgentConfig {
  readonly effort: string;
  readonly maxToolCalls: number;
  readonly maxTokens?: number;
  /** Provider-specific reasoning settings; see `reasoningOptions`. */
  readonly providerOptions?: Record<string, Record<string, JSONValue>>;
}

export interface ToolCallRecord {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly output: string;
  readonly ms: number;
  readonly failed: boolean;
}

export interface AgentRun {
  readonly answer: unknown;
  readonly submitted: boolean;
  readonly calls: readonly ToolCallRecord[];
  /** Everything the tools handed back, which is what retrieval is scored on. */
  readonly observedText: string;
  readonly usage: UsageTotals;
  readonly ms: number;
  readonly stopReason: string | null;
  /** The provider's words, when the request never ran. */
  readonly failure?: string;
}

/**
 * Whether the provider refused because the prompt was too big.
 *
 * Matched on the message because the four providers spell it four ways and
 * none of them gives it a stable code — OpenAI says `context_length_exceeded`,
 * Anthropic talks about the maximum number of tokens, and Azure wraps both.
 * A miss here costs an outcome label, not a wrong number: the run is recorded
 * as a failure either way, and only the reason is less specific.
 */
function overflowed(error: unknown): boolean {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    text.includes('context length') ||
    text.includes('context_length') ||
    text.includes('context window') ||
    text.includes('too many tokens') ||
    text.includes('maximum context') ||
    (text.includes('prompt') && text.includes('too long'))
  );
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** Input tokens on the final request: what the model had to read to answer. */
  finalInputTokens: number;
}

const SYSTEM = `You are answering questions about a software project from a memory of stored tool results.

Rules:
- Everything you need is in the memory. Do not guess, and do not answer from general knowledge.
- Records are identified by refs shaped like pr:1421, inc:INC-03, svc:billing, ci:run-0042, file:f-007, iss:ENG-214.
- When a question asks for refs, answer with the exact refs, not with titles or numbers.
- Call submit_answer exactly once, when you have the answer. That is the only answer that is read.`;

const SUBMIT = 'submit_answer';

function answerSchema(question: Question): Record<string, unknown> {
  if (question.gold.kind === 'number') {
    return {
      type: 'object',
      properties: { answer: { type: 'integer', description: 'The count.' } },
      required: ['answer'],
      additionalProperties: false,
    };
  }
  const ordered = question.gold.kind === 'list';
  return {
    type: 'object',
    properties: {
      answer: {
        type: 'array',
        items: { type: 'string' },
        description: ordered
          ? 'The refs, in the order the question asked for.'
          : 'The refs, in any order. Give every one that matches and no others.',
      },
    },
    required: ['answer'],
    additionalProperties: false,
  };
}

export async function runAgent(
  model: LanguageModel,
  adapter: MemoryAdapter,
  question: Question,
  config: AgentConfig,
): Promise<AgentRun> {
  const started = Date.now();
  const calls: ToolCallRecord[] = [];
  const observed: string[] = [];
  let answer: unknown;
  let submitted = false;
  let retrievalCalls = 0;

  const tools: ToolSet = {
    [SUBMIT]: tool({
      description: 'Submit your final answer. Call this exactly once.',
      inputSchema: jsonSchema(answerSchema(question)),
      execute: async (input: unknown) => {
        answer = (input as { answer?: unknown }).answer;
        submitted = true;
        return 'Recorded.';
      },
    }),
  };

  for (const spec of adapter.tools()) {
    tools[spec.name] = tool({
      description: spec.description,
      inputSchema: jsonSchema(spec.input_schema),
      execute: async (input: unknown) => {
        retrievalCalls += 1;
        const callStarted = Date.now();
        let output: string;
        let failed = false;
        try {
          output = await adapter.call(spec.name, (input ?? {}) as Record<string, unknown>);
        } catch (error) {
          // Returned rather than thrown: the model is the one who can fix a
          // mistyped column, and a run where it recovers from its own bad SQL
          // reflects how the product behaves.
          failed = true;
          output = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
        }
        calls.push({
          name: spec.name,
          input: (input ?? {}) as Record<string, unknown>,
          output,
          ms: Date.now() - callStarted,
          failed,
        });
        observed.push(output);
        return output;
      },
    });
  }

  const note = await adapter.systemNote(question);

  let result: Awaited<ReturnType<typeof generateText>>;
  try {
    result = await generateText({
    model,
    system: note ? `${SYSTEM}\n\n${note}` : SYSTEM,
    prompt: question.text,
    tools,
    // Stop as soon as the answer is in, and hard-stop a model that will not
    // use the answer channel. The +2 leaves room for the budget-exhausted turn
    // and one nudge, so "ran out of calls" stays distinguishable from "wrong".
    stopWhen: [hasToolCall(SUBMIT), stepCountIs(config.maxToolCalls + 2)],
    // Once the retrieval budget is spent the tools come off the table and only
    // the answer channel is left. Cutting the run off entirely would score
    // "ran out of calls" the same as "answered wrongly".
    prepareStep: () =>
      retrievalCalls >= config.maxToolCalls ? { activeTools: [SUBMIT] } : {},
      ...(config.providerOptions ? { providerOptions: config.providerOptions } : {}),
      ...(config.maxTokens ? { maxOutputTokens: config.maxTokens } : {}),
    });
  } catch (error) {
    // A provider that refuses the request is a result, not a crash.
    //
    // The case this exists for is a memory too large to put in a prompt:
    // `raw-context` is handed the whole corpus and the request is rejected
    // before inference. Letting that throw would abandon every question after
    // it in the same adapter, and would report the most interesting outcome
    // this benchmark can produce as a harness bug.
    //
    // It is recorded as its own outcome rather than as a wrong answer, because
    // "there is no ceiling for a memory this size" and "the ceiling is 0%" are
    // different findings and the report has to be able to tell them apart.
    return {
      answer: undefined,
      submitted: false,
      calls,
      observedText: observed.join('\n'),
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, finalInputTokens: 0 },
      ms: Date.now() - started,
      stopReason: overflowed(error) ? 'context-overflow' : 'provider-error',
      failure: error instanceof Error ? error.message : String(error),
    };
  }

  const steps = result.steps ?? [];
  const usage: UsageTotals = {
    inputTokens: result.usage?.inputTokens ?? 0,
    outputTokens: result.usage?.outputTokens ?? 0,
    cacheReadTokens: result.usage?.inputTokenDetails?.cacheReadTokens ?? 0,
    // The last step's input is what the model had to read to answer, which is
    // the number that separates a three-row query from a fifty-row search.
    finalInputTokens: steps.at(-1)?.usage?.inputTokens ?? 0,
  };

  return {
    answer,
    submitted,
    calls,
    observedText: observed.join('\n'),
    usage,
    ms: Date.now() - started,
    stopReason: result.finishReason ?? null,
  };
}
