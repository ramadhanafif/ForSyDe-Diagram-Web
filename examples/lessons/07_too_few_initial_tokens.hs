module Lesson07 where

-- Lesson 7: a delay with too few initial tokens.
-- The rates are consistent: a_step fires twice for each a_pair firing. But
-- a_pair must read 2 tokens from s_1 before it writes any back, and d_1 lets
-- a_step fire only once.

import ForSyDe.Shallow

system :: Signal Int -> Signal Int
system s_in = s_out
  where
    (s_out, s_1) = a_step s_in s_3
    s_2 = a_pair s_1
    s_3 = d_1 s_2

a_step :: Signal Int -> Signal Int -> (Signal Int, Signal Int)
a_step s t = actor22SDF (1, 1) (1, 1) step s t

a_pair :: Signal Int -> Signal Int
a_pair s = actor11SDF 2 2 swap s

d_1 :: Signal Int -> Signal Int
d_1 s = delaySDF [0] s

step :: [Int] -> [Int] -> ([Int], [Int])
step [x] [y] = ([x + y], [x + y])

swap :: [Int] -> [Int]
swap [x, y] = [y, x]
