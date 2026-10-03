"""Statistical checks that distinguish input sensitivity from paired solver bias."""
import runpy
import unittest
from pathlib import Path

MODULE = runpy.run_path(str(Path(__file__).with_name("paired-statistics.py")))


class StatisticsTests(unittest.TestCase):
    def test_interpolated_quartiles_on_even_sample(self):
        d = MODULE["distribution"]([9, 0, 6, 3, 8, 2, 5, 1, 7, 4])
        self.assertEqual((d["q1"], d["median"], d["q3"]), (2.25, 4.5, 6.75))

    def test_large_native_spread_does_not_hide_constant_paired_bias(self):
        result = MODULE["metric"]([1, 2, 3, 4, 5], [1.1, 2.2, 3.3, 4.4, 5.5])
        self.assertAlmostEqual(result["signedErrorPercent"]["median"], 10)
        self.assertAlmostEqual(result["absoluteErrorPercent"]["q3"], 10)
        self.assertGreater(result["nativeRelativeIqrPercent"], 60)

    def test_signed_lift_and_small_reference_floor(self):
        result = MODULE["metric"]([-.2, 0], [-.1, .002])
        self.assertAlmostEqual(result["signedErrorPercent"]["median"], 35)
        self.assertAlmostEqual(result["absoluteErrorPercent"]["max"], 50)

    def test_equal_paired_values_have_zero_error_despite_input_variation(self):
        values = [.1, .8, .2, .7, .3, .6, .4, .5, .9, 1.]
        result = MODULE["metric"](values, values)
        self.assertEqual(result["absoluteErrorPercent"]["max"], 0)
        self.assertEqual(result["bootstrapMedianSignedError95Percent"], [0, 0])


if __name__ == "__main__":
    unittest.main()
