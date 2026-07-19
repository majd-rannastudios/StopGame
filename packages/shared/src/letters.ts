import { Lang } from "./ruleset";

/** Visual wheel arcs === true probability. Difficulty is controlled by pool membership only. */
export const LETTER_POOLS: Record<Lang, { easy: string[]; hard: string[] }> = {
  en: {
    easy: "A B C D E F G H I J K L M N O P R S T U V W".split(" "),
    hard: "A B C D E F G H I J K L M N O P Q R S T U V W X Y Z".split(" "),
  },
  fr: {
    easy: "A B C D E F G H I J L M N O P R S T U V".split(" "),
    hard: "A B C D E F G H I J K L M N O P Q R S T U V W".split(" "),
  },
  ar: {
    // ة is NEVER included (never word-initial). Easy excludes ث ذ ظ.
    easy: "ا ب ت ج ح خ د ر ز س ش ص ض ط ع غ ف ق ك ل م ن ه و ي".split(" "),
    hard: "ا ب ت ث ج ح خ د ذ ر ز س ش ص ض ط ظ ع غ ف ق ك ل م ن ه و ي".split(" "),
  },
};

export function resolvePool(lang: Lang, difficulty: "easy" | "hard" = "easy"): string[] {
  return [...LETTER_POOLS[lang][difficulty]];
}
