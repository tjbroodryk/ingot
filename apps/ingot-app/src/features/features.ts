/**
 * `/features`: the ways an ingot can be asked, one per section, and one
 * query that uses three of them at once.
 *
 * Every sample is a call the service answers today, in the shapes
 * `src/docs/reference.ts` documents. `test/features.test.tsx` holds them to
 * that; a page that sells a function the engine does not have is worse than
 * no page.
 */

export const FEATURES_LEDE =
  'Every ingot is a set of real tables. Filter them with SQL, rank them by meaning, match names that were misspelled, and do all three in the same query.';

export const FEATURES_DESCRIPTION =
  'What an ingot can be asked: SQL over typed columns, similarity over embedded text, fuzzy matching on names, chunked documents, and receipts in place of payloads.';

/** The ingot every sample on the page is written against. */
const INGOT = '/api/v1/acme/ing_01H8Z…';

export interface Feature {
  readonly id: string;
  /** What the contents and the kicker call it. */
  readonly name: string;
  readonly summary: string;
  readonly title: string;
  readonly lede: string;
  /** Every call here is a POST, so only the path is kept. */
  readonly path: string;
  readonly request: string;
  /** The line between request and response: status, and what came back. */
  readonly status: string;
  readonly response: string;
  readonly when: readonly string[];
  readonly not: string;
}

export const FEATURES: readonly Feature[] = [
  {
    id: 'sql',
    name: 'Structured search',
    summary: 'Real SQL over typed columns. Exact filters, counts, joins and ordering.',
    title: 'Exact answers, written in SQL',
    lede: 'Each ingot stores tool results as typed tables. The model writes the query it needs and gets back only the rows that answer it, so a count comes back as one number rather than forty records.',
    path: `${INGOT}/query`,
    request: `{ "sql": "SELECT company, arr
          FROM contacts
          WHERE stage = 'won'
            AND closed_at >= '2026-07-01'
          ORDER BY arr DESC
          LIMIT 3" }`,
    status: '200 · 3 rows · 34 ms',
    response: `{ "columns": ["company", "arr"],
  "rows": [
    { "company": "Northwind", "arr": 184000 },
    { "company": "Contoso",   "arr": 96500 },
    { "company": "Fabrikam",  "arr": 71200 } ],
  "truncated": false, "next": null }`,
    when: [
      'The question has a number in the answer: how many, how much, the largest',
      'Order matters, such as first, latest or top five',
      'The answer is something missing, like records with no owner',
    ],
    not: 'The wording in the question differs from the wording in the record. SQL matches values, not meaning. Use similarity search for that.',
  },
  {
    id: 'similarity',
    name: 'Similarity search',
    summary: 'Rank text columns by meaning, for questions phrased differently from the data.',
    title: 'Find it by what it means',
    lede: 'Declare a column with `embed: true` on `/add` and Ingot embeds it after the write. Send `text` with a query and it is embedded too, bound as `$q`, so a question about running out of database connections finds the record that says the pool was exhausted.',
    path: `${INGOT}/query`,
    request: `{ "text": "ran out of spare database connections",
  "sql": "SELECT id, summary,
            array_cosine_similarity(summary_vec, $q)
              AS score
          FROM incidents
          ORDER BY score DESC
          LIMIT 3" }`,
    status: '200 · 3 rows · 41 ms',
    response: `{ "columns": ["id", "summary", "score"],
  "rows": [
    { "id": "INC-01", "score": 0.83,
      "summary": "Connection pool exhausted on catalog-db" },
    { "id": "INC-09", "score": 0.71,
      "summary": "Replica lag after pool resize" },
    { "id": "INC-04", "score": 0.64,
      "summary": "Timeouts from search under load" } ] }`,
    when: [
      'The question paraphrases the record rather than quoting it',
      'You need the closest few matches, not every match',
      'The text is written by people, like summaries, notes and descriptions',
    ],
    not: 'You need every matching row, or a count of them. Similarity returns a ranking, not a complete set. Filter with SQL first.',
  },
  {
    id: 'fuzzy',
    name: 'Fuzzy search',
    summary: 'Match names and identifiers through typos, spacing and spelling variants.',
    title: 'Close enough, on purpose',
    lede: 'Names get misspelled, in the data and in the question. The query runs in DuckDB, so its string-distance functions come with it: `jaro_winkler_similarity` finds John Kowalski from "Jon Kowalsky", and "north wind" finds Northwind. Nothing is embedded, so it works on any text column.',
    path: `${INGOT}/query`,
    request: `{ "sql": "SELECT id, name, company
          FROM contacts
          WHERE jaro_winkler_similarity(
            lower(name), 'jon kowalsky') > 0.85" }`,
    status: '200 · 1 row · 22 ms',
    response: `{ "columns": ["id", "name", "company"],
  "rows": [
    { "id": "c_2291", "name": "John Kowalski",
      "company": "Contoso" } ] }`,
    when: [
      'Looking up a person, company or product by a name someone typed',
      'Identifiers that vary in case, spacing or punctuation',
      'Joining two payloads whose keys almost match',
    ],
    not: 'The strings share no characters, like "outage" and "incident". Edit distance can’t link synonyms. Similarity search can.',
  },
  {
    id: 'documents',
    name: 'Document chunking',
    summary: 'Upload a document and it is split into chunks you can search and cite.',
    title: 'Long text, in pieces that fit',
    lede: 'A contract or a runbook is too long to embed as one value and too long to read back whole. Upload it to `/file` and Ingot parses, chunks and embeds it in the background. Each chunk keeps its page and section heading, so an answer can say where it came from.',
    path: `${INGOT}/file`,
    request: `-F "file=@q3-contracts.pdf"
-F 'body={ "chunkTokens": 800,
           "overlapTokens": 120 }'`,
    status: '201 · stored and queued',
    response: `{ "fileId": "file_3f9c1a…",
  "mediaType": "application/pdf",
  "status": "pending",
  "chunksQuery": "SELECT … FROM ingot_file_chunks
     WHERE file_id = 'file_3f9c1a…'
     ORDER BY ordinal" }`,
    when: [
      'You have documents, threads or transcripts rather than tool results',
      'You want the paragraph that answers the question, not the whole document',
      'You need to cite where an answer came from, by page or section',
    ],
    not: 'The text is already short values in your own tables, like names or one-line summaries. Chunking is for uploaded documents; embed those columns instead.',
  },
  {
    id: 'receipts',
    name: 'Receipts',
    summary: 'Optional. Store a large tool result and hand the model a short receipt instead.',
    title: 'Keep the payload, send the receipt',
    lede: 'Some tools return more than the context window can hold. `/add` stores all of it either way; the receipt is what goes back to the model in its place. `schema` hands back the table and the queries that find these rows, and `full` adds a summary and a search term, written in the background.',
    path: `${INGOT}/add`,
    request: `{ "table": "contacts",
  "rows": "$.contacts[*]",
  "key": ["id"],
  "receipt": "full",
  "result": toolResult }`,
    status: '201 · 21,507 tok stored',
    response: `{ "table": "contacts", "rowsAdded": 412,
  "receipt": {
    "status": "pending",
    "receiptQuery": "SELECT … FROM ingot_receipts
       WHERE source_batch = 'batch_1508c8…'" } }

# seconds later, receiptQuery answers
{ "summary": "412 EMEA accounts, 17 at risk",
  "search_term": "EMEA renewal risk" }`,
    when: [
      'A single tool call returns thousands of records',
      'The agent needs to know what arrived before deciding what to ask',
      'You are paying for tokens the model never uses',
    ],
    not: 'The result is small enough to read whole. A receipt then costs an extra query to get back what the model could have read directly.',
  },
];

export const COMBINED = {
  id: 'combining',
  name: 'Combining them',
  summary: 'SQL, fuzzy and similarity together in one query.',
  title: 'One query, three kinds of search',
  lede: 'They are all one SELECT, so they compose. SQL narrows the rows exactly, fuzzy matching finds the name as someone typed it, and similarity puts what is left in order of meaning.',
  path: `${INGOT}/query`,
  request: `{ "text": "cannot finish checkout",
  "sql": "SELECT t.id, t.subject
          FROM tickets t
          JOIN contacts c ON c.id = t.contact_id
          WHERE t.status = 'open'
            AND jaro_winkler_similarity(
              lower(c.company), 'north wind') > 0.85
          ORDER BY array_cosine_similarity(
            t.body_vec, $q) DESC
          LIMIT 3" }`,
  status: '200 · 3 rows · 58 ms',
  response: `{ "columns": ["id", "subject"],
  "rows": [
    { "id": "T-4410", "subject": "Payment step spins forever" },
    { "id": "T-4398", "subject": "Card declined after address change" },
    { "id": "T-4371", "subject": "Order total shows zero" } ] }`,
  steps: [
    { label: 'SQL filters', text: 'Only open tickets, joined to the contact who raised them.' },
    {
      label: 'Fuzzy matches',
      text: '"north wind" matches Northwind, however the company was typed.',
    },
    {
      label: 'Similarity ranks',
      text: 'What remains is ordered by how close the thread is to "cannot finish checkout".',
    },
  ],
} as const;
