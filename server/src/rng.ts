import { randomInt, randomBytes, createHash } from "crypto";
import { LetterDrawMode } from "@stop/shared";

/** CSPRNG only — never Math.random for anything gameplay-visible. */
export const csprngInt = (maxExclusive: number) => randomInt(maxExclusive);

export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = csprngInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export interface DrawResult {
  letter: string;
  poolIndex: number;
  spinSeed: number;
  rotations: number;
  nonce: string;
  commitHash: string;
}

export class LetterBag {
  private bag: string[] = [];
  private last = "";
  constructor(private pool: string[], private mode: LetterDrawMode) {}

  draw(): DrawResult {
    let letter: string;
    switch (this.mode) {
      case "bag":
        if (this.bag.length === 0) this.bag = shuffle(this.pool);
        letter = this.bag.pop()!;
        break;
      case "noImmediateRepeat":
        do { letter = this.pool[csprngInt(this.pool.length)]; }
        while (letter === this.last && this.pool.length > 1);
        break;
      default:
        letter = this.pool[csprngInt(this.pool.length)];
    }
    this.last = letter;
    const nonce = randomBytes(16).toString("hex");
    const commitHash = createHash("sha256").update(letter + nonce).digest("hex");
    return {
      letter,
      poolIndex: this.pool.indexOf(letter),
      spinSeed: csprngInt(2 ** 31),
      rotations: 5 + csprngInt(4), // 5–8 full turns
      nonce,
      commitHash,
    };
  }
}

/** Unambiguous room codes (no 0/O/1/I). ~1.07B combos at length 6. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function makeRoomCode(len = 6): string {
  let s = "";
  for (let i = 0; i < len; i++) s += CODE_ALPHABET[csprngInt(CODE_ALPHABET.length)];
  return s;
}
