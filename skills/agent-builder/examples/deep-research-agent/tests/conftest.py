"""Shared pytest setup.

Ensures a provider key is present so importing modules that build a model at
import time (nodes.py) does not fail in a keyless CI environment. The dummy key
is never used for a network call in these tests.
"""

import os

os.environ.setdefault("OPENAI_API_KEY", "sk-test-not-used")
os.environ.setdefault("ANTHROPIC_API_KEY", "sk-ant-test-not-used")
