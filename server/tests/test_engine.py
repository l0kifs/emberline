import pytest

from emberline.engine.cache import CompletionCache, context_key
from emberline.engine.supersede import Supersede


class TestCache:
    def test_hit_and_miss_accounting(self):
        c = CompletionCache(max_entries=4)
        assert c.get("k") is None
        c.put("k", "v")
        assert c.get("k") == "v"
        assert (c.hits, c.misses) == (1, 1)

    def test_evicts_least_recently_used(self):
        c = CompletionCache(max_entries=2)
        c.put("a", "1")
        c.put("b", "2")
        c.get("a")  # 'a' is now the most recent, so 'b' should go first
        c.put("c", "3")
        assert c.get("a") == "1"
        assert c.get("b") is None
        assert len(c) == 2

    def test_reinserting_does_not_grow(self):
        c = CompletionCache(max_entries=2)
        c.put("a", "1")
        c.put("a", "2")
        assert len(c) == 1
        assert c.get("a") == "2"


class TestContextKey:
    def test_same_context_same_key(self):
        assert context_key("p", "s", "e", "d") == context_key("p", "s", "e", "d")

    @pytest.mark.parametrize(
        "args",
        [
            ("P", "s", "e", "d"),
            ("p", "S", "e", "d"),
            ("p", "s", "E", "d"),  # different extra context must not collide
            ("p", "s", "e", "D"),  # nor different sampling params
        ],
    )
    def test_any_component_change_changes_key(self, args):
        assert context_key(*args) != context_key("p", "s", "e", "d")

    def test_field_boundaries_are_not_ambiguous(self):
        # Without a separator, ("ab","c") and ("a","bc") would hash identically.
        assert context_key("ab", "c", "e", "d") != context_key("a", "bc", "e", "d")


class TestSupersede:
    def test_newer_claim_makes_older_stale(self):
        s = Supersede()
        first = s.claim("doc")
        assert not s.is_stale("doc", first)
        second = s.claim("doc")
        assert s.is_stale("doc", first)
        assert not s.is_stale("doc", second)

    def test_sessions_are_independent(self):
        # The bug this guards: a global counter means two editors abort each other.
        s = Supersede()
        a = s.claim("docA")
        b = s.claim("docB")
        assert not s.is_stale("docA", a)
        assert not s.is_stale("docB", b)

    def test_forget_resets(self):
        s = Supersede()
        gen = s.claim("doc")
        s.forget("doc")
        assert s.is_stale("doc", gen)
