#!/bin/sh
set -eu

# Bind-mounted SQLite files may have been created by the root-running dev image.
# Repair only the dedicated data mount, then drop privileges for the application.
chown -R node:node /data
exec gosu node "$@"
