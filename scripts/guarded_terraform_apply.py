"""Apply an exact Terraform plan only if it preserves the production load balancer."""
from __future__ import annotations

import csv
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


def protect_directory(directory: Path) -> None:
    os.chmod(directory, 0o700)
    if os.name == 'nt':
        identity = subprocess.run(
            ['whoami', '/user', '/fo', 'csv', '/nh'], check=True, text=True, capture_output=True,
        ).stdout.strip()
        sid = next(csv.reader([identity]))[1]
        subprocess.run(
            ['icacls', str(directory), '/inheritance:r', '/grant:r', f'*{sid}:(OI)(CI)F'],
            check=True, text=True, capture_output=True,
        )


def changes_load_balancer_identity(plan: dict, existing_certificate: bool) -> bool:
    return any(
        item.get('address') == 'aws_lb.main' and (
            'delete' in item.get('change', {}).get('actions', []) or
            (existing_certificate and 'create' in item.get('change', {}).get('actions', []))
        )
        for item in [*plan['resource_changes'], *plan.get('resource_drift', [])]
    )


def main(variables: list[str]) -> None:
    terraform = ['terraform', '-chdir=infra/terraform/app']
    with tempfile.TemporaryDirectory(prefix='battleship-tf-plan-') as temporary:
        directory = Path(temporary)
        protect_directory(directory)
        plan_file = directory / 'production.tfplan'
        subprocess.run([*terraform, 'plan', '-input=false', f'-out={plan_file}', *variables], check=True)
        raw_plan = subprocess.run(
            [*terraform, 'show', '-json', str(plan_file)], check=True, text=True, capture_output=True,
        ).stdout
        plan = json.loads(raw_plan)
        if (not isinstance(plan, dict) or not str(plan.get('format_version', '')).startswith('1.')
                or not isinstance(plan.get('resource_changes'), list) or not isinstance(plan.get('resource_drift', []), list)):
            raise ValueError('Unexpected Terraform plan format; refusing to apply it.')
        if changes_load_balancer_identity(plan, Path('.deployment/tls.json').exists()):
            raise RuntimeError(
                'Terraform plans to delete or replace the production load balancer. '
                'Deployment stopped before applying the plan to preserve the certificate hostname. '
                'Review the changes; if replacement is intended, run ./setup.sh down prod '
                'and deploy afresh (this deletes production data).'
            )
        subprocess.run([*terraform, 'apply', '-input=false', str(plan_file)], check=True)


if __name__ == '__main__':
    try:
        main(sys.argv[1:])
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f'Production deployment stopped: {error}', file=sys.stderr)
        sys.exit(1)
