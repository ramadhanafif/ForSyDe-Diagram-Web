module Lesson06 where

-- Lesson 6: inconsistent rates.
-- The top path doubles the token count and the bottom path does not, so a_join
-- would get twice as many tokens on s_3 as on s_4. No buffer is ever big enough.

import ForSyDe.Shallow

system :: Signal Int -> Signal Int
system s_in = s_out
  where
    (s_1, s_2) = a_split s_in
    s_3 = a_twice s_1
    s_4 = a_once s_2
    s_out = a_join s_3 s_4

a_split :: Signal Int -> (Signal Int, Signal Int)
a_split s = actor12SDF 1 (1, 1) split s

a_twice :: Signal Int -> Signal Int
a_twice s = actor11SDF 1 2 twice s

a_once :: Signal Int -> Signal Int
a_once s = actor11SDF 1 1 once s

a_join :: Signal Int -> Signal Int -> Signal Int
a_join s t = actor21SDF (1, 1) 1 add s t

split :: [Int] -> ([Int], [Int])
split [x] = ([x], [x])

twice :: [Int] -> [Int]
twice [x] = [x, x]

once :: [Int] -> [Int]
once [x] = [x]

add :: [Int] -> [Int] -> [Int]
add [x] [y] = [x + y]
