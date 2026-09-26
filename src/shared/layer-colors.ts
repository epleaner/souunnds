export const LAYER_COLOR_BACKGROUND = "#101112";
export const MIN_LAYER_COLOR_CONTRAST = 4.5;

const PASTEL_SATURATION = 0.64;
const PASTEL_LIGHTNESSES = [0.72, 0.82] as const;
const PASTEL_COLOR_COUNT = 24;

type Rgb = { red: number; green: number; blue: number };
type Oklab = { lightness: number; a: number; b: number };

function hslToRgb(hue: number, saturation: number, lightness: number): Rgb {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const segment = ((hue % 360) + 360) % 360 / 60;
  const secondary = chroma * (1 - Math.abs(segment % 2 - 1));
  const [red, green, blue] = segment < 1 ? [chroma, secondary, 0]
    : segment < 2 ? [secondary, chroma, 0]
      : segment < 3 ? [0, chroma, secondary]
        : segment < 4 ? [0, secondary, chroma]
          : segment < 5 ? [secondary, 0, chroma]
            : [chroma, 0, secondary];
  const match = lightness - chroma / 2;
  return { red: red + match, green: green + match, blue: blue + match };
}

function rgbToHex({ red, green, blue }: Rgb): string {
  return `#${[red, green, blue].map((channel) => Math.round(channel * 255).toString(16).padStart(2, "0")).join("")}`;
}

function hexToRgb(color: string): Rgb | null {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color);
  if (!match) return null;
  return {
    red: Number.parseInt(match[1], 16) / 255,
    green: Number.parseInt(match[2], 16) / 255,
    blue: Number.parseInt(match[3], 16) / 255,
  };
}

function linearChannel(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(color: string): number {
  const rgb = hexToRgb(color);
  if (!rgb) return 0;
  return 0.2126 * linearChannel(rgb.red) + 0.7152 * linearChannel(rgb.green) + 0.0722 * linearChannel(rgb.blue);
}

function toOklab(color: string): Oklab | null {
  const rgb = hexToRgb(color);
  if (!rgb) return null;
  const red = linearChannel(rgb.red);
  const green = linearChannel(rgb.green);
  const blue = linearChannel(rgb.blue);
  const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  return {
    lightness: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

export const PASTEL_LAYER_COLORS = Array.from({ length: PASTEL_COLOR_COUNT }, (_, index) => (
  rgbToHex(hslToRgb((20 + index * 137.508) % 360, PASTEL_SATURATION, PASTEL_LIGHTNESSES[index % PASTEL_LIGHTNESSES.length]))
));

export function isPastelLayerColor(value: unknown): value is string {
  return typeof value === "string" && PASTEL_LAYER_COLORS.includes(value.toLowerCase());
}

export function layerColorContrast(color: string): number {
  const foreground = relativeLuminance(color);
  const background = relativeLuminance(LAYER_COLOR_BACKGROUND);
  return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
}

export function layerColorDistance(first: string, second: string): number {
  const firstLab = toOklab(first);
  const secondLab = toOklab(second);
  if (!firstLab || !secondLab) return 0;
  return 100 * Math.hypot(
    firstLab.lightness - secondLab.lightness,
    firstLab.a - secondLab.a,
    firstLab.b - secondLab.b,
  );
}

export function nextPastelLayerColor(
  existingColors: Iterable<string>,
  random: () => number = Math.random,
): string {
  const existing = [...existingColors].filter(isPastelLayerColor).map((color) => color.toLowerCase());
  const boundedRandom = Math.min(0.999999, Math.max(0, random()));
  const offset = Math.floor(boundedRandom * PASTEL_LAYER_COLORS.length);
  const rotated = PASTEL_LAYER_COLORS.map((_, index) => PASTEL_LAYER_COLORS[(index + offset) % PASTEL_LAYER_COLORS.length]);
  const unused = rotated.filter((candidate) => !existing.includes(candidate));
  const candidates = unused.length ? unused : rotated;
  if (!existing.length) return candidates[0];

  let selected = candidates[0];
  let selectedDistance = -1;
  for (const candidate of candidates) {
    const distance = Math.min(...existing.map((color) => layerColorDistance(candidate, color)));
    if (distance > selectedDistance) {
      selected = candidate;
      selectedDistance = distance;
    }
  }
  return selected;
}
