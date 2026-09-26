module Lesson05 where

-- Lesson 5: a deadlock.
-- a_acc waits for a token from a_back, and a_back waits for a token from a_acc.
-- No token is on the loop at the start, so neither can ever fire. Fix: a delay.

import ForSyDe.Shallow

system :: Signal Int -> Signal Int
system s_in = s_out
  where
    (s_out, s_1) = a_acc s_in s_2
    s_2 = a_back s_1

a_acc :: Signal Int -> Signal Int -> (Signal Int, Signal Int)
a_acc s t = actor22SDF (1, 1) (1, 1) acc s t

a_back :: Signal Int -> Signal Int
a_back s = actor11SDF 1 1 inc s

acc :: [Int] -> [Int] -> ([Int], [Int])
acc [x] [y] = ([x + y], [x + y])

inc :: [Int] -> [Int]
inc [x] = [x + 1]
