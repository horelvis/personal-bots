/**
 * The character avatars: pictures cut from the artwork in avatars/ by web/scripts/gen-avatars.py.
 * A bot's `avatarShape` is either one of the drawn shapes or the id of a character. The pictures
 * are transparent around the figure, so each bot's colour shows behind its character.
 */

export const CHARACTERS = [
  { id: 'bot-casual', name: 'Casual' },
  { id: 'bot-music', name: 'Headphones' },
  { id: 'bot-suit', name: 'Suit' },
  { id: 'bot-executive', name: 'Executive' },
  { id: 'bot-scientist', name: 'Scientist' },
  { id: 'bot-researcher', name: 'Researcher' },
  { id: 'bot-hiker', name: 'Hiker' },
  { id: 'bot-explorer', name: 'Explorer' },
  { id: 'bot-chef', name: 'Chef' },
  { id: 'bot-attendant', name: 'Flight attendant' },
] as const;

export type CharacterId = (typeof CHARACTERS)[number]['id'];

export const isCharacter = (shape: unknown): shape is CharacterId => CHARACTERS.some((c) => c.id === shape);

/** Where the app serves a character's picture from. */
export const characterUrl = (id: string) => `/assets/avatars/${id}.png`;

/**
 * A character as a round SVG, for the places that only take SVG (the bot's home screen). The
 * picture goes in as a data URI, over a disc of the bot's colour with a white rim.
 */
export function characterSvg(dataUri: string, background = '#E8ECF3'): string {
  if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(dataUri)) throw new Error('characterSvg takes a base64 data URI of a PNG or JPEG');
  if (!/^#[0-9a-fA-F]{6}$/.test(background)) background = '#E8ECF3';
  return '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 96 96">'
    + '<circle cx="48" cy="48" r="48" fill="#fff"/>'
    + `<circle cx="48" cy="48" r="44" fill="${background}"/>`
    + '<clipPath id="hqc"><circle cx="48" cy="48" r="44"/></clipPath>'
    + `<image x="4" y="4" width="88" height="88" href="${dataUri}" xlink:href="${dataUri}" clip-path="url(#hqc)"/>`
    + '</svg>';
}
