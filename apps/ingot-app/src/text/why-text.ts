/**
 * `/why`, as markdown. See `./reference-text.ts` for why.
 *
 * The page this renders is an argument, which is the one kind of document a
 * model is *more* likely to be handed than a person is: "why would I use this
 * rather than a vector store" is a question asked of an assistant far more
 * often than it is asked of a website. So the plain-text half of this page
 * matters at least as much as the HTML, and it is generated from the same
 * constants rather than written a second time — a page that argued one thing
 * on the site and another in `llms-full.txt` would be worse than one that had
 * no markdown at all.
 */

import type { Article } from './markdown';
import { blocks, bullets, fence, heading, table } from './markdown';
import {
  COSTS,
  GRAIN_CHIPS,
  GRAIN_LIMIT,
  GRAINS,
  LOSS_CLAIM,
  LOSSES,
  OWN_IT,
  SQL_NOTES,
  THE_JOIN,
  WHY_DESCRIPTION,
  WHY_LEDE,
  WHY_TITLE,
  THREE_TOOLS,
  TIERS,
  VECTOR_COLUMN,
} from '../why/why';

/** The page, as `llms.txt` lists it and as the file it links to. */
export const WHY: Article = {
  // What the nav calls it rather than the headline, for the reason
  // `DEPLOYMENT` uses "Deployment": this is an entry in an index, and an index
  // is read by scanning the left edge of it.
  title: 'Why Ingot',
  summary: WHY_DESCRIPTION,
  render: renderWhy,
};

function renderWhy(): string {
  return `${blocks(
    heading(1, WHY_TITLE),
    `> ${WHY_DESCRIPTION}`,
    WHY_LEDE,

    heading(2, 'Three ways to lose a tool result'),
    'A tool returns four hundred rows of structured JSON. By the next turn one of these three has happened to it, and none of the three can be queried.',
    table(
      ['What happens to it', 'What it costs'],
      LOSSES.map((loss) => [`**${loss.title}.** ${loss.body}`, loss.cost]),
    ),
    LOSS_CLAIM,

    heading(2, 'Why SQL'),
    'SQL is the most written-down query language there is, and a model is fluent in it in a way it is not fluent in anybody’s retrieval API. It is also the only one that fails loudly — a SELECT returns rows or it errors with a reason, and a model that got it wrong can narrow it and run it again. A ranking always returns something, and being wrong looks exactly like being right.',
    fence(THREE_TOOLS),
    fence(THE_JOIN),
    bullets(SQL_NOTES.map((note) => `**${note.title}** (\`${note.source}\`): ${note.body}`)),

    heading(2, 'Where the embeddings went'),
    'None of this is an argument against embeddings — it is an argument about where they belong. A vector is a column beside the row it was made from, and `array_cosine_similarity(body_vec, $q)` is an expression in a SELECT list like any other. So meaning becomes one predicate in a statement that also joins two tables, filters on a real date and counts. The arrangement with a vector store beside it cannot write that statement at all: the vectors are over there, the columns are over here, and the only thing that crosses between them is a list of ids.',
    fence(VECTOR_COLUMN),

    heading(2, 'One memory per whatever you say'),
    'Ingot has no opinion about what a memory is for. Casting one is a POST with a name and a retention, so the boundary can be the boundary your system already has — a chat, a run, a project, a tenant.',
    table(
      ['Retention', 'Scope', 'What it is for'],
      GRAINS.map((grain) => [`\`${grain.retention}\``, grain.title, grain.body]),
    ),
    GRAIN_LIMIT,
    `Managed with: ${GRAIN_CHIPS.map((call) => `\`${call}\``).join(', ')}.`,

    heading(2, 'What it costs to keep'),
    'An LSM tree and nothing more exotic. Nothing in it is resident: there is no index to keep warm, no cluster sized to the corpus, and nothing that bills per vector.',
    bullets(TIERS.map((tier) => `**${tier.title}** (${tier.note}): ${tier.body}`)),
    table(
      ['What a memory costs', 'What that is'],
      COSTS.map((cost) => [cost.item, cost.body]),
    ),

    heading(2, 'Your bucket, your rows'),
    'There is no hosted Ingot, and here that is the point rather than the caveat. The Postgres is yours and the bucket is yours, and what is in the bucket is Parquet — not an index, not a proprietary segment file, and not something that needs this service running to be read.',
    'So there is no export, because there is no second format to export from. A table’s current generation is one file, and anything that reads Parquet reads it: DuckDB on your laptop, pandas, Spark, whatever you already pay for. If Ingot stops, the memory does not.',
    fence(OWN_IT),
  )}\n`;
}
