/** Blank model for File > New: one input through one actor to one output. */
export const BLANK_MODEL = `module Model where

import ForSyDe.Shallow

-- Netlist
system :: Signal Int -> Signal Int
system s_in = s_out
  where
    s_out = a_1 s_in

-- Process specifications
a_1 :: Signal Int -> Signal Int
a_1 s = actor11SDF 1 1 f_1 s

-- Function definitions
f_1 :: [Int] -> [Int]
f_1 [x] = [x]

main :: IO ()
main =
  getLine >>= \\line ->
    putStrLn . unwords . map show . fromSignal . system . signal . map read . words $ line
`;

const MODULE_RE = /^module[ \t]+([A-Z][A-Za-z0-9_'.]*)/m;

/** Download name for Export .hs: the module name, else `model.hs`. */
export function exportFileName(source: string): string {
  const name = MODULE_RE.exec(source)?.[1];
  return `${name ?? 'model'}.hs`;
}
