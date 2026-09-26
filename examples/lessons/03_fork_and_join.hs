module Lesson03 where

-- Lesson 3: fork and join with buffers.
-- a_split writes 2 tokens to the top path and 1 to the bottom path. a_top fires
-- twice per iteration, and s_3 must buffer both results before a_join can fire.

import ForSyDe.Shallow

system :: Signal Int -> Signal Int
system s_in = s_out
  where
    (s_1, s_2) = a_split s_in
    s_3 = a_top s_1
    s_4 = a_bottom s_2
    s_out = a_join s_3 s_4

a_split :: Signal Int -> (Signal Int, Signal Int)
a_split s = actor12SDF 1 (2, 1) split s

a_top :: Signal Int -> Signal Int
a_top s = actor11SDF 1 1 neg s

a_bottom :: Signal Int -> Signal Int
a_bottom s = actor11SDF 1 1 neg s

a_join :: Signal Int -> Signal Int -> Signal Int
a_join s t = actor21SDF (2, 1) 1 join3 s t

split :: [Int] -> ([Int], [Int])
split [x] = ([x, x], [x])

neg :: [Int] -> [Int]
neg [x] = [negate x]

join3 :: [Int] -> [Int] -> [Int]
join3 [x, y] [z] = [x + y + z]
