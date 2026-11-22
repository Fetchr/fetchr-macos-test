import type { SVGProps } from "react";

/*
 * Фирменный знак Split F и слово «etchr» — контуры из брендового пакета
 * (Round 7, сетка 96). В строке знак заменяет первую F, поэтому слово
 * начинается с «e».
 *
 * Знак и слово живут в одной вертикальной рамке y = 14…89: при одинаковой
 * высоте их базовые линии совпадают сами, а зазор между ними равен
 * BRAND_GAP высоты рамки — как в эталонном локапе.
 */
export const SPLIT_F_BODY =
  "M18 14H87Q91 14 91 18V29Q91 33 87 33H34V48H43Q47 48 47 52V63Q47 67 43 67H34V80Q34 84 30 84H18Q14 84 14 80V18Q14 14 18 14Z";

export const SPLIT_F_FRAGMENT = "M71 48H87Q91 48 91 52V63Q91 67 87 67H71Q67 67 67 63V52Q67 48 71 48Z";

const WORDMARK =
  "M135.32 88.18C147.42 88.18 157.02 81.17 158.98 71.03H147.42C146 75.44 141.83 78.43 135.61 78.43C127.28 78.43 122.48 72.79 122.19 64.37H159.62V60.98C159.62 45.11 149.72 34.09 134.83 34.09C120.33 34.09 110.09 45.45 110.09 61.18C110.09 76.86 119.79 88.18 135.32 88.18ZM122.29 55.84C123.12 48.44 127.87 43.89 135.02 43.89C142.18 43.89 146.98 48.44 147.76 55.84ZM176 22H189V39H205L202 50H189V68Q189 75 197 75H204V84Q199 88 192 88Q175 88 175 70V50H166V39H176ZM232.37 88.18C245.45 88.18 254.95 79.75 255.83 68.43H243.64C242.46 74.16 238.98 77.89 232.51 77.89C224.38 77.89 219.58 71.37 219.58 61.18C219.58 50.94 224.43 44.38 232.51 44.38C238.93 44.38 242.8 48.25 243.73 53.78H255.83C254.76 42.27 245.35 34.09 232.37 34.09C217.23 34.09 207.09 45.21 207.09 61.18C207.09 77.15 217.23 88.18 232.37 88.18ZM267 14H281V46Q290 37 302 37Q324 37 324 63V87H310V65Q310 51 299 51Q287 51 281 65V87H267ZM337 38H351V47Q360 36 372 37Q377 37 381 39L377 52Q373 51 369 51Q351 52 351 71V87H337Z";

/** Буквы слова по отдельности (e — внешний контур и глазок вместе) для интро */
const WORDMARK_PARTS = WORDMARK.split(/(?=M)/);
export const WORDMARK_LETTERS = [
  WORDMARK_PARTS[0] + WORDMARK_PARTS[1],
  WORDMARK_PARTS[2],
  WORDMARK_PARTS[3],
  WORDMARK_PARTS[4],
  WORDMARK_PARTS[5],
] as const;
/** Левый и правый край каждой буквы в единицах сетки */
export const WORDMARK_LETTER_LEFT = [110, 166, 207, 267, 337] as const;
export const WORDMARK_LETTER_RIGHT = [160, 205, 256, 324, 381] as const;

/** Рамки обоих элементов в единицах сетки: общая высота, своя ширина */
export const BRAND_FRAME_HEIGHT = 75;
export const MARK_VIEWBOX = `14 14 77 ${BRAND_FRAME_HEIGHT}`;
const WORDMARK_VIEWBOX = `110 14 271 ${BRAND_FRAME_HEIGHT}`;

/** Ширина знака, слова и зазора в долях высоты рамки */
export const BRAND_MARK_RATIO = 77 / BRAND_FRAME_HEIGHT;
export const BRAND_WORD_RATIO = 271 / BRAND_FRAME_HEIGHT;
export const BRAND_GAP_RATIO = 19 / BRAND_FRAME_HEIGHT;

export const BRAND_ACCENT = "#3D7DFF";

export function BrandMark({ fill = BRAND_ACCENT, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox={MARK_VIEWBOX} aria-hidden="true" focusable="false" {...props}>
      <path fill={fill} d={SPLIT_F_BODY + SPLIT_F_FRAGMENT} />
    </svg>
  );
}

export function BrandWordmark({ fill = "currentColor", ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox={WORDMARK_VIEWBOX} aria-hidden="true" focusable="false" {...props}>
      <path fill={fill} d={WORDMARK} />
    </svg>
  );
}
