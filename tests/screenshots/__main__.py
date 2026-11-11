"""Command line for the screenshot run: ``uv run python -m tests.screenshots --help``."""

import os

from tests.screenshots.environment import scrub_process_env

# Settings classes read os.environ, and GEOMETRIKKS_ENV_FILE picks their dotenv file, when
# geometrikks.config.settings is first imported. Scrub before anything can import it.
INPUTS = scrub_process_env(os.environ)

if __name__ == "__main__":
    import sys

    from tests.screenshots.run import main, parse_args

    sys.exit(main(parse_args(sys.argv[1:], INPUTS), INPUTS))
