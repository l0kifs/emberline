from emberline.postprocess import trim_completion


def test_passes_through_normal_completion():
    assert trim_completion("return a + b", suffix="\n") == "return a + b"


def test_drops_whitespace_only():
    # Ghost text made of whitespace swallows the Tab key for nothing.
    assert trim_completion("   \n  ", suffix="") == ""
    assert trim_completion("", suffix="") == ""


def test_strips_overlap_with_suffix():
    # Cursor sits before ')', model helpfully emits ')' too -> accepting yields '))'.
    assert trim_completion("foo(a, b)", suffix=")\n") == "foo(a, b"


def test_strips_longest_overlap():
    assert trim_completion("value\n}\n", suffix="\n}\nrest") == "value"


def test_no_overlap_left_alone():
    assert trim_completion("xyz", suffix="abc") == "xyz"


def test_strips_trailing_newlines():
    assert trim_completion("done\n\n\n", suffix="") == "done"


def test_overlap_stripping_can_empty_the_completion():
    # The model produced only what already follows the cursor: nothing to offer.
    assert trim_completion(")", suffix=")") == ""
