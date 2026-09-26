module Lesson04 where

-- Lesson 4: a feedback loop with a delay.
-- a_acc reads its own previous output back through d_1. The delay holds one
-- initial token, so a_acc can fire the first time. Compare with lesson 5.

import ForSyDe.Shallow

system :: Signal Int -> Signal Int
system s_in = s_out
  where
    (s_out, s_1) = a_acc s_in s_2
    s_2 = d_1 s_1

a_acc :: Signal Int -> Signal Int -> (Signal Int, Signal Int)
a_acc s t = actor22SDF (1, 1) (1, 1) acc s t

d_1 :: Signal Int -> Signal Int
d_1 s = delaySDF [0] s

acc :: [Int] -> [Int] -> ([Int], [Int])
acc [x] [y] = ([x + y], [x + y])
