import { ContentValidationError, type ContentConfiguration, type ContentType, type FrameDefinition } from './content-model.js';

export interface NarrativeFrame {
  index: number;
  role: FrameDefinition['role'];
  headline: string | null;
  body: string | null;
}

export interface Narrative {
  topic: string;
  title: string;
  frames: NarrativeFrame[];
  caption: string;
  hashtags: string[];
}

export interface NarrativeInput {
  type: ContentType;
  language: string;
  niche: string;
  projectDescription: string;
  topic: string;
  tone: string;
  audience: string;
  customInstructions: string;
  ctaMode: ContentConfiguration['ctaMode'];
  ctaText: string;
  textMode: ContentConfiguration['textMode'];
  roles: FrameDefinition[];
}

const topicWords = (value: string): string[] => value.split(/[^a-zA-Z0-9]+/).map((word) => word.trim()).filter((word) => word.length > 2).slice(0, 4);
const titleCase = (value: string): string => value.replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());

function defaultTopic(input: NarrativeInput): string {
  if (input.topic.trim()) return input.topic.trim();
  const niche = input.niche.trim() || 'your niche';
  return `Practical ${niche} ideas for ${input.audience.trim() || 'curious people'}`;
}

function bodyFor(topic: string, niche: string, index: number, tone: string): string {
  const options = [
    `Start with one clear action and make it easy to repeat.`,
    `Focus on the small choice that creates a useful result over time.`,
    `Use a simple system so the idea works beyond a single good day.`,
    `Review what works, keep the signal, and remove unnecessary friction.`,
    `Make the next step specific enough to try before the day is over.`
  ];
  const style = tone ? ` Keep the approach ${tone.toLowerCase()} and practical.` : '';
  return `${options[(index - 1) % options.length]}${style}`.slice(0, 240);
}

export function generateNarrative(input: NarrativeInput): Narrative {
  const topic = defaultTopic(input);
  const niche = input.niche.trim() || 'this topic';
  const title = input.roles.length > 1 ? `${Math.max(1, input.roles.filter((role) => role.role === 'content').length)} ideas for ${titleCase(topic)}` : titleCase(topic);
  const frames: NarrativeFrame[] = input.roles.map((definition, index) => {
    if (input.textMode === 'none') return { index: index + 1, role: definition.role, headline: null, body: null };
    if (input.textMode === 'cover_only' && !['cover', 'title_and_summary'].includes(definition.role)) return { index: index + 1, role: definition.role, headline: null, body: null };
    if (definition.role === 'cover') return { index: index + 1, role: definition.role, headline: title, body: null };
    if (definition.role === 'title_and_summary') return { index: index + 1, role: definition.role, headline: title, body: input.textMode === 'headline_only' ? null : bodyFor(topic, niche, index, input.tone) };
    if (definition.role === 'cta') {
      const headline = input.ctaMode === 'none' ? null : input.ctaMode === 'user' && input.ctaText.trim() ? input.ctaText.trim() : `Follow for more ${niche.toLowerCase()} ideas`;
      return { index: index + 1, role: definition.role, headline: headline?.slice(0, 120) ?? null, body: null };
    }
    const headline = input.textMode === 'headline_only' ? `${titleCase(niche)} idea ${index}` : `Make ${titleCase(niche)} easier`;
    const body = input.textMode === 'headline_only' ? null : bodyFor(topic, niche, index, input.tone);
    return { index: index + 1, role: definition.role, headline: headline.slice(0, 120), body: body?.slice(0, 240) ?? null };
  });
  const tags = topicWords(`${topic} ${niche}`).map((word) => `#${word.toLowerCase()}`).slice(0, 5);
  const caption = `A practical guide to ${topic.toLowerCase()}. Save this for the next time you want a simple ${niche.toLowerCase()} reset.`.slice(0, 500);
  return { topic, title: title.slice(0, 160), frames, caption, hashtags: tags };
}

export function validateNarrative(narrative: unknown, roles: FrameDefinition[], configuration: ContentConfiguration): Narrative {
  if (!narrative || typeof narrative !== 'object') throw new ContentValidationError('INVALID_NARRATIVE', 'The narrative response is not an object.');
  const value = narrative as Record<string, unknown>;
  if (typeof value.topic !== 'string' || typeof value.title !== 'string' || !Array.isArray(value.frames) || typeof value.caption !== 'string' || !Array.isArray(value.hashtags)) throw new ContentValidationError('INVALID_NARRATIVE_SCHEMA', 'The narrative is missing required fields.');
  if (value.frames.length !== roles.length) throw new ContentValidationError('INVALID_FRAME_COUNT', `Narrative returned ${value.frames.length} frames; ${roles.length} were required.`);
  const frames = value.frames.map((frame, index) => {
    if (!frame || typeof frame !== 'object') throw new ContentValidationError('INVALID_NARRATIVE_FRAME', `Frame ${index + 1} is invalid.`);
    const item = frame as Record<string, unknown>;
    const expected = roles[index]!;
    if (item.index !== index + 1 || item.role !== expected.role) throw new ContentValidationError('INVALID_FRAME_ROLE_ORDER', `Frame ${index + 1} does not match the requested role order.`);
    for (const key of ['headline', 'body']) if (item[key] !== null && typeof item[key] !== 'string') throw new ContentValidationError('INVALID_NARRATIVE_FIELD', `Frame ${index + 1} contains an invalid text field.`);
    const headline = item.headline as string | null;
    const body = item.body as string | null;
    if (headline && headline.length > 120) throw new ContentValidationError('HEADLINE_TOO_LONG', `Frame ${index + 1} headline exceeds 120 characters.`);
    if (body && body.length > 240) throw new ContentValidationError('BODY_TOO_LONG', `Frame ${index + 1} body exceeds 240 characters.`);
    if (configuration.textMode === 'none' && (headline || body)) throw new ContentValidationError('TEXT_NOT_ALLOWED', 'Text was returned while text mode is none.');
    if (configuration.textMode === 'cover_only' && !['cover', 'title_and_summary'].includes(expected.role) && (headline || body)) throw new ContentValidationError('TEXT_NOT_ALLOWED', 'Text was returned outside the cover while text mode is cover_only.');
    if (['cover_only', 'headline_only'].includes(configuration.textMode) && body) throw new ContentValidationError('BODY_NOT_ALLOWED', 'Body text was returned for a headline-only text mode.');
    return { index: index + 1, role: expected.role, headline, body };
  });
  return {
    topic: value.topic.trim().slice(0, 240),
    title: value.title.trim().slice(0, 160),
    frames,
    caption: value.caption.trim().slice(0, 500),
    hashtags: value.hashtags.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.slice(0, 40)).slice(0, 12)
  };
}
