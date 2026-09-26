module Lesson02 where

-- Lesson 2: a multirate chain.
-- a_up writes 2 tokens per firing and a_down reads 3, so the balance equation
-- 2 q(a_up) = 3 q(a_down) gives q = (3, 2): a_up fires 3 times, a_down twice.

import ForSyDe.Shallow

system :: Signal Int -> Signal Int
system s_in = s_out
  where
    s_1 = a_up s_in
    s_out = a_down s_1

a_up :: Signal Int -> Signal Int
a_up s = actor11SDF 1 2 up s

a_down :: Signal Int -> Signal Int
a_down s = actor11SDF 3 1 down s

up :: [Int] -> [Int]
up [x] = [x, x]

down :: [Int] -> [Int]
down [x, y, z] = [x + y + z]
