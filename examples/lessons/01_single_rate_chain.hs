module Lesson01 where

-- Lesson 1: a single-rate chain.
-- Every actor reads 1 token and writes 1 token per firing, so each fires once
-- per schedule iteration. Press Animate and follow one token from s_in to s_out.

import ForSyDe.Shallow

system :: Signal Int -> Signal Int
system s_in = s_out
  where
    s_1 = a_double s_in
    s_out = a_inc s_1

a_double :: Signal Int -> Signal Int
a_double s = actor11SDF 1 1 double s

a_inc :: Signal Int -> Signal Int
a_inc s = actor11SDF 1 1 inc s

double :: [Int] -> [Int]
double [x] = [2 * x]

inc :: [Int] -> [Int]
inc [x] = [x + 1]
