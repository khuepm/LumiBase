/**
 * Wordlist + helpers for the "Generate Random" button on the Admin Path
 * step of the Setup Wizard.
 *
 * Spec refs: requirements §4.1; design.md §5.5.
 *
 * Why a curated wordlist?
 *
 *   The generator emits paths shaped like `/<word>-<6 hex chars>`. The
 *   word component gives the operator something memorable enough to
 *   recognise their own admin URL when they bookmark it; the 6 hex
 *   suffix supplies the unpredictability against bots that just scan
 *   a dictionary. Cherry-picking a small, neutral wordlist avoids both
 *   "/passw0rd-…"-style guessable suggestions AND words that an
 *   operator might find offensive on first run.
 *
 * Selection criteria for entries (all enforced by the `isValidWord`
 * compile-time runtime check below):
 *
 *   - lowercase ASCII only, no digits, no hyphens, no punctuation
 *     (the hyphen separator is added by the generator);
 *   - length ∈ [3, 12] so combined `<word>-<6hex>` is well within the
 *     CMS-side regex `^/[a-z0-9][a-z0-9-]{2,62}[a-z0-9]$` (max combined
 *     length: 12 + 1 + 6 = 19 chars after the leading `/`);
 *   - everyday neutral nouns (animals, plants, weather, food, gems,
 *     objects, mythology) — no profanity, no slurs, no political,
 *     religious, or cultural identifiers, no proper nouns;
 *   - ≥ 256 unique entries so the entropy contribution from the word
 *     itself is ≥ 8 bits on top of the 24 bits from the hex suffix
 *     (≥ 32 bits combined; collisions in the random space are
 *     vanishingly rare, so the retry cap of 8 in
 *     `wordlistGenerateUnique` only ever exists to bounce off the
 *     blacklist on the rare collision).
 */

import {
  ADMIN_PATH_REGEX,
  DEFAULT_ADMIN_PATHS_BLACKLIST,
  RESERVED_PATH_PREFIXES,
  normalizeAdminPath,
} from './schemas/admin-path';

// ────────────────────────────────────────────────────────────────────────
// The wordlist
// ────────────────────────────────────────────────────────────────────────
//
// Grouped by theme purely for readability — the runtime treats the array
// as a flat list and picks uniformly. Keep additions sorted within each
// group to make duplicate detection during code review easier; the
// runtime de-dup check below catches the rest.

const RAW_WORDLIST: ReadonlyArray<string> = [
  // Animals — mammals
  'antelope', 'badger', 'bear', 'beaver', 'bison', 'buffalo', 'camel',
  'caribou', 'cheetah', 'chimp', 'cougar', 'coyote', 'deer', 'donkey',
  'elephant', 'elk', 'ferret', 'fox', 'gazelle', 'giraffe', 'goat',
  'gopher', 'gorilla', 'hamster', 'hare', 'hedgehog', 'hippo', 'horse',
  'koala', 'lemur', 'leopard', 'lion', 'llama', 'lynx', 'marmot',
  'mole', 'mongoose', 'monkey', 'moose', 'mouse', 'narwhal', 'okapi',
  'orca', 'otter', 'panda', 'panther', 'platypus', 'puma', 'rabbit',
  'raccoon', 'reindeer', 'seal', 'sheep', 'sloth', 'squirrel', 'tapir',
  'tiger', 'walrus', 'weasel', 'whale', 'wolf', 'wombat', 'zebra',

  // Animals — birds
  'crane', 'crow', 'dove', 'eagle', 'falcon', 'finch', 'flamingo',
  'goose', 'hawk', 'heron', 'kestrel', 'kingfisher', 'lark', 'macaw',
  'magpie', 'nightingale', 'oriole', 'osprey', 'owl', 'parrot',
  'peacock', 'pelican', 'penguin', 'pheasant', 'puffin', 'quail',
  'raven', 'robin', 'sparrow', 'starling', 'swallow', 'swan', 'tern',
  'thrush', 'toucan', 'vulture', 'woodpecker', 'wren',

  // Animals — water + reptiles
  'clam', 'coral', 'crab', 'dolphin', 'eel', 'gecko', 'iguana', 'koi',
  'lobster', 'lizard', 'newt', 'octopus', 'oyster', 'perch', 'prawn',
  'salmon', 'shrimp', 'snail', 'snake', 'sponge', 'starfish', 'toad',
  'trout', 'tuna', 'turtle', 'urchin',

  // Animals — bugs
  'ant', 'beetle', 'butterfly', 'cicada', 'cricket', 'dragonfly',
  'firefly', 'ladybug', 'mantis', 'moth', 'spider', 'wasp',

  // Plants — trees + flowers
  'alder', 'almond', 'ash', 'aspen', 'beech', 'birch', 'cactus',
  'cedar', 'cherry', 'cypress', 'elm', 'fern', 'fir', 'holly', 'ivy',
  'juniper', 'lavender', 'lilac', 'lily', 'lotus', 'mahogany', 'maple',
  'mint', 'moss', 'oak', 'orchid', 'palm', 'peony', 'pine', 'poplar',
  'redwood', 'rose', 'sage', 'sequoia', 'spruce', 'sycamore', 'teak',
  'thistle', 'thyme', 'tulip', 'willow', 'wisteria', 'yew',

  // Nature — water + land
  'atoll', 'bay', 'beach', 'brook', 'canyon', 'cliff', 'cove', 'creek',
  'delta', 'desert', 'dune', 'fjord', 'forest', 'geyser', 'glacier',
  'glade', 'grove', 'harbor', 'hill', 'island', 'jungle', 'lagoon',
  'lake', 'marsh', 'meadow', 'oasis', 'ocean', 'pasture', 'peak',
  'plateau', 'pond', 'prairie', 'reef', 'ridge', 'river', 'savanna',
  'shore', 'summit', 'swamp', 'tundra', 'valley', 'volcano', 'waterfall',

  // Nature — sky + weather
  'aurora', 'blizzard', 'breeze', 'cloud', 'comet', 'dawn', 'drizzle',
  'dusk', 'eclipse', 'equinox', 'frost', 'galaxy', 'hail', 'meteor',
  'mist', 'monsoon', 'moon', 'nebula', 'planet', 'quasar', 'rain',
  'rainbow', 'sky', 'sleet', 'snow', 'star', 'storm', 'sunrise',
  'sunset', 'thunder', 'twilight',

  // Gems + colors
  'agate', 'amber', 'amethyst', 'azure', 'cobalt', 'copper', 'crimson',
  'ebony', 'emerald', 'garnet', 'indigo', 'ivory', 'jade', 'lapis',
  'magenta', 'ochre', 'onyx', 'opal', 'pearl', 'platinum', 'quartz',
  'ruby', 'sapphire', 'scarlet', 'sepia', 'silver', 'slate', 'topaz',
  'turquoise', 'violet',

  // Food — fruits + nuts
  'almond', 'apple', 'apricot', 'banana', 'berry', 'cashew', 'date',
  'fig', 'grape', 'guava', 'hazelnut', 'kiwi', 'lemon', 'lime', 'mango',
  'melon', 'olive', 'papaya', 'peach', 'peanut', 'pecan', 'pear',
  'plum', 'walnut',

  // Food — vegetables + spices
  'basil', 'beetroot', 'cabbage', 'carrot', 'celery', 'chive',
  'cilantro', 'cumin', 'fennel', 'garlic', 'ginger', 'kale', 'leek',
  'lettuce', 'mushroom', 'onion', 'parsley', 'pepper', 'potato',
  'pumpkin', 'radish', 'rosemary', 'saffron', 'spinach', 'squash',
  'tarragon', 'tomato', 'truffle', 'turnip',

  // Objects — tools + everyday
  'anchor', 'anvil', 'atlas', 'beacon', 'book', 'candle', 'compass',
  'forge', 'helm', 'journal', 'kettle', 'kiln', 'lantern', 'ledger',
  'loom', 'mortar', 'paddle', 'parchment', 'pestle', 'pitcher',
  'satchel', 'scroll', 'sextant', 'shuttle', 'telescope', 'torch',

  // Boats + transport
  'canoe', 'dinghy', 'frigate', 'galleon', 'kayak', 'raft', 'schooner',
  'skiff', 'sleigh', 'wagon',

  // Mythology + fantasy (neutral, common-domain)
  'basilisk', 'chimera', 'dragon', 'griffin', 'hydra', 'kraken',
  'oracle', 'pegasus', 'phoenix', 'sphinx', 'sprite', 'unicorn',

  // Roles + verbs (neutral)
  'bard', 'beacon', 'compass', 'envoy', 'herald', 'lantern', 'minstrel',
  'pioneer', 'ranger', 'scholar', 'voyager', 'wanderer',
];

// ────────────────────────────────────────────────────────────────────────
// Validation + de-duplication (runs once at module load)
// ────────────────────────────────────────────────────────────────────────

const WORD_REGEX = /^[a-z]{3,12}$/;

function isValidWord(word: string): boolean {
  return WORD_REGEX.test(word);
}

const seen = new Set<string>();
const validated: string[] = [];
for (const word of RAW_WORDLIST) {
  if (!isValidWord(word)) {
    // Fail loudly so a bad PR can't ship a malformed entry.
    throw new Error(
      `[wordlist] Entry "${word}" violates ^[a-z]{3,12}$. ` +
      `Wordlist must be lowercase ASCII only with 3–12 chars.`,
    );
  }
  if (!seen.has(word)) {
    seen.add(word);
    validated.push(word);
  }
}

if (validated.length < 256) {
  // Spec-mandated floor (Req 4.1, design §5.5: "wordlist ≥256 từ").
  throw new Error(
    `[wordlist] Need at least 256 unique words; have ${validated.length}.`,
  );
}

/**
 * Final de-duplicated wordlist used for path generation. Frozen so a
 * downstream caller can't mutate it (every entry is a primitive so a
 * shallow freeze is sufficient).
 */
export const ADMIN_PATH_WORDLIST: ReadonlyArray<string> = Object.freeze(
  validated,
);

// ────────────────────────────────────────────────────────────────────────
// CSPRNG helpers
// ────────────────────────────────────────────────────────────────────────

/**
 * Fetch the platform Web Crypto provider (browser `window.crypto` or
 * Node's globalThis.crypto). Throws if no CSPRNG is available — the
 * Setup Wizard runs in the browser where this is always defined; the
 * fallback is only meaningful for unit tests.
 */
function getCrypto(): Crypto {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = (globalThis as any).crypto as Crypto | undefined;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new Error(
      '[wordlist] Web Crypto API unavailable. ' +
      'Cannot generate a secure random admin path.',
    );
  }
  return c;
}

/**
 * Pick a uniformly random word from `ADMIN_PATH_WORDLIST`.
 *
 * Uses rejection sampling against a 32-bit unsigned range so the
 * distribution is not biased by `% wordlist.length` truncation when
 * the list size doesn't divide 2^32 evenly.
 */
function pickRandomWord(): string {
  const c = getCrypto();
  const n = ADMIN_PATH_WORDLIST.length;
  const buf = new Uint32Array(1);
  const limit = Math.floor(0xffffffff / n) * n;
  // Loop bound: with n=300, ~98% of draws succeed first try; the
  // expected iteration count is below 1.02. The `for (;;)` is bounded
  // in practice by the rejection probability; tests assert this loop
  // never runs more than a small number of iterations.
  for (let i = 0; i < 64; i += 1) {
    c.getRandomValues(buf);
    const v = buf[0]!;
    if (v < limit) {
      const word = ADMIN_PATH_WORDLIST[v % n];
      if (word !== undefined) return word;
    }
  }
  // Fallback: extremely unlikely; degrade to non-rejection-sampled
  // pick rather than throw, so the UI never silently fails.
  c.getRandomValues(buf);
  return ADMIN_PATH_WORDLIST[buf[0]! % n]!;
}

/**
 * Generate 6 lowercase hex characters (24 bits of entropy).
 */
function pickRandomHex6(): string {
  const c = getCrypto();
  const buf = new Uint8Array(3);
  c.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < buf.length; i += 1) {
    const byte = buf[i]!;
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────

/**
 * Generate one candidate admin path, shaped `/<word>-<6 hex>`.
 *
 * Always returns a string; does NOT consult the blacklist — see
 * `wordlistGenerateUnique` for that. The result is already in the
 * canonical normalised form (lowercase, single leading slash, no
 * trailing slash) and matches `ADMIN_PATH_REGEX`.
 */
export function wordlistGenerate(): string {
  const word = pickRandomWord();
  const hex = pickRandomHex6();
  return `/${word}-${hex}`;
}

/**
 * Default blacklist check used by `wordlistGenerateUnique`. A candidate
 * is "blacklisted" if it appears verbatim in the Default_Admin_Paths
 * list or if it starts with one of the reserved system prefixes
 * (Req 4.3, 4.4). Both checks are performed against the *normalised*
 * candidate so the rare path through `normalizeAdminPath` returning
 * something different from the raw input still gets caught.
 */
export function isAdminPathBlacklisted(candidate: string): boolean {
  const normalized = normalizeAdminPath(candidate);
  if (normalized === null) return true;

  if (DEFAULT_ADMIN_PATHS_BLACKLIST.includes(normalized)) return true;

  for (const reserved of RESERVED_PATH_PREFIXES) {
    if (
      normalized === reserved ||
      normalized.startsWith(`${reserved}/`) ||
      normalized.startsWith(`${reserved}-`)
    ) {
      // Belt-and-braces: while the wordlist itself excludes the bare
      // reserved prefixes, we also reject `/api-…` etc. so a generated
      // suggestion never *looks* like a system prefix.
      return true;
    }
  }

  return false;
}

export interface WordlistGenerateUniqueOptions {
  /**
   * Maximum number of attempts before giving up. Spec design §5.5
   * mandates a cap of 8 retries; lower values are accepted for tests.
   */
  maxAttempts?: number;
  /**
   * Override the blacklist check (used in tests). Receives the raw
   * candidate from `wordlistGenerate()` and should return `true` to
   * reject.
   */
  isBlacklisted?: (candidate: string) => boolean;
}

/**
 * Generate a path that is NOT in the blacklist, retrying up to
 * `maxAttempts` times. Returns `null` when the cap is exhausted (the
 * caller should surface an "couldn't generate, please try again or
 * enter manually" error).
 *
 * The default `maxAttempts=8` matches the spec hard cap. Combined with
 * the wordlist size (≥256 entries), an exhaustion event is improbable
 * in practice — the cap exists to prevent any hypothetical infinite
 * loop in the face of an adversarial blacklist override during tests.
 */
export function wordlistGenerateUnique(
  options: WordlistGenerateUniqueOptions = {},
): string | null {
  const maxAttempts = options.maxAttempts ?? 8;
  const isBlacklisted = options.isBlacklisted ?? isAdminPathBlacklisted;

  if (maxAttempts <= 0) return null;

  for (let i = 0; i < maxAttempts; i += 1) {
    const candidate = wordlistGenerate();
    // Defence in depth: also assert the format. A malformed candidate
    // can only happen if the wordlist or hex helper regress; the
    // ADMIN_PATH_REGEX check makes the regression visible immediately.
    if (!ADMIN_PATH_REGEX.test(candidate)) continue;
    if (!isBlacklisted(candidate)) return candidate;
  }
  return null;
}
