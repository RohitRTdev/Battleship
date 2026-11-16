"""Create, verify, and remove the production load balancer's imported certificate."""
from __future__ import annotations

import json
import csv
import os
import secrets
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEPLOYMENT = ROOT / '.deployment'
STATE = DEPLOYMENT / 'tls.json'
CERT = DEPLOYMENT / 'server.crt'
KEY = DEPLOYMENT / 'server.key'
TAG = 'battleship-tls-id'


def run(*args: str, input: str | None = None) -> str:
    return subprocess.run(args, input=input, text=True, check=True, stdout=subprocess.PIPE).stdout.strip()


def generate_certificate(config: Path) -> None:
    result = subprocess.run(
        ['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '365',
         '-keyout', str(KEY), '-out', str(CERT), '-config', str(config)],
        text=True, capture_output=True,
    )
    if result.returncode:
        raise RuntimeError(f'OpenSSL certificate generation failed: {result.stderr.strip()}')


def save(state: dict) -> None:
    DEPLOYMENT.mkdir(mode=0o700, exist_ok=True)
    temporary = STATE.with_suffix('.tmp')
    temporary.write_text(json.dumps(state, indent=2) + '\n', encoding='utf-8')
    os.chmod(temporary, 0o600)
    temporary.replace(STATE)


def aws(*args: str) -> str:
    return run('aws', *args, '--output', 'json')


def recover_arn(state: dict) -> str | None:
    """Recover a tagged import if the process stopped before saving its ARN."""
    summaries = json.loads(aws('acm', 'list-certificates'))['CertificateSummaryList']
    matches = []
    for item in summaries:
        arn = item['CertificateArn']
        tags = json.loads(aws('acm', 'list-tags-for-certificate', '--certificate-arn', arn))['Tags']
        if any(tag['Key'] == TAG and tag['Value'] == state['id'] for tag in tags):
            matches.append(arn)
    if len(matches) > 1:
        raise RuntimeError('Multiple ACM certificates match this deployment; resolve them manually.')
    return matches[0] if matches else None


def check_scope(state: dict) -> None:
    account = json.loads(aws('sts', 'get-caller-identity'))['Account']
    if state.get('region') != os.environ['AWS_REGION'] or state.get('stack') != os.environ['PROD_STACK_NAME'] or state.get('account') != account:
        raise RuntimeError('TLS metadata does not match the configured AWS account, region and stack.')


def check_ownership(state: dict, arn: str) -> None:
    tags = json.loads(aws('acm', 'list-tags-for-certificate', '--certificate-arn', arn))['Tags']
    if not any(tag['Key'] == TAG and tag['Value'] == state['id'] for tag in tags):
        raise RuntimeError('The ACM certificate is not tagged as belonging to this deployment.')


def fingerprint(pem: str) -> str:
    return run('openssl', 'x509', '-noout', '-fingerprint', '-sha256', input=pem)


def protect_private_key() -> None:
    os.chmod(KEY, 0o600)
    if os.name == 'nt':
        # chmod does not restrict Windows ACLs. Remove inherited grants and
        # give the current account access before OpenSSL writes key material.
        identity = next(csv.reader([run('whoami', '/user', '/fo', 'csv', '/nh')]))
        run('icacls', str(KEY), '/inheritance:r', '/grant:r', f'*{identity[1]}:(F)')


def validate(state: dict, hostname: str) -> None:
    check_scope(state)
    if state.get('hostname') != hostname:
        raise RuntimeError('Load balancer hostname changed; run down prod and deploy afresh.')
    if not CERT.is_file() or not KEY.is_file():
        raise RuntimeError('Certificate or private key is missing; restore .deployment or run down prod.')
    host_check = run('openssl', 'x509', '-in', str(CERT), '-noout', '-checkhost', hostname)
    if 'does match certificate' not in host_check:
        raise RuntimeError('The saved certificate does not match the load balancer hostname.')
    try:
        run('openssl', 'x509', '-in', str(CERT), '-noout', '-checkend', '0')
    except subprocess.CalledProcessError as error:
        raise RuntimeError('The certificate is expired or invalid; run down prod and deploy afresh.') from error
    cert_public = run('openssl', 'x509', '-in', str(CERT), '-pubkey', '-noout')
    key_public = run('openssl', 'pkey', '-in', str(KEY), '-pubout')
    if cert_public != key_public:
        raise RuntimeError('The saved certificate and private key do not match.')
    check_ownership(state, state['arn'])
    remote = json.loads(aws('acm', 'get-certificate', '--certificate-arn', state['arn']))['Certificate']
    if fingerprint(remote) != fingerprint(CERT.read_text(encoding='ascii')):
        raise RuntimeError('The ACM certificate differs from the saved certificate; restore it before deploying.')


def prepare(hostname: str) -> None:
    if STATE.exists():
        state = json.loads(STATE.read_text(encoding='utf-8'))
        check_scope(state)
        if state.get('deleted'):
            raise RuntimeError('Certificate was deleted during teardown; complete down prod before redeploying.')
        if not state.get('arn'):
            state['arn'] = recover_arn(state)
            if not state['arn']:
                raise RuntimeError('An earlier certificate import is incomplete. Check ACM for the tagged certificate before removing .deployment/tls.json.')
            save(state)
        validate(state, hostname)
    else:
        if CERT.exists() or KEY.exists():
            raise RuntimeError('Untracked TLS files exist in .deployment; resolve them before deploying.')
        DEPLOYMENT.mkdir(mode=0o700, exist_ok=True)
        os.chmod(DEPLOYMENT, 0o700)
        config = DEPLOYMENT / 'openssl.cnf'
        config.write_text('[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Battleship production\n[ext]\nsubjectAltName=DNS:' + hostname +
                          '\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n', encoding='ascii')
        try:
            old_umask = os.umask(0o077)
            try:
                KEY.touch(mode=0o600, exist_ok=False)
                protect_private_key()
                generate_certificate(config)
            finally:
                os.umask(old_umask)
        finally:
            config.unlink(missing_ok=True)
        os.chmod(KEY, 0o600)
        state = {'id': secrets.token_hex(16), 'hostname': hostname, 'arn': None,
                 'account': json.loads(aws('sts', 'get-caller-identity'))['Account'],
                 'region': os.environ['AWS_REGION'], 'stack': os.environ['PROD_STACK_NAME']}
        save(state)  # Journal before the remote operation so interrupted imports can be located.
        result = json.loads(aws('acm', 'import-certificate', '--certificate', 'fileb://' + str(CERT),
                                '--private-key', 'fileb://' + str(KEY),
                                '--tags', f'Key={TAG},Value={state["id"]}'))
        state['arn'] = result['CertificateArn']
        save(state)
        validate(state, hostname)
    print(run('openssl', 'x509', '-in', str(CERT), '-noout', '-enddate', '-fingerprint', '-sha256'), file=sys.stderr)
    print(state['arn'])


def remove() -> None:
    if not STATE.exists():
        if CERT.exists() or KEY.exists():
            raise RuntimeError('TLS files exist without metadata; check ACM for an imported certificate before cleanup.')
        return
    state = json.loads(STATE.read_text(encoding='utf-8'))
    check_scope(state)
    arn = state.get('arn') or recover_arn(state)
    if not arn:
        raise RuntimeError('Cannot confirm whether the pending ACM import succeeded; inspect ACM before cleanup.')
    if arn:
        # Persist the ARN before deletion so interrupted cleanup can be retried.
        state['arn'] = arn
        save(state)
        if state.get('deleted'):
            return
        result = subprocess.run(['aws', 'acm', 'list-tags-for-certificate', '--certificate-arn', arn, '--output', 'json'],
                                text=True, capture_output=True)
        if result.returncode == 0:
            tags = json.loads(result.stdout)['Tags']
            if not any(tag['Key'] == TAG and tag['Value'] == state['id'] for tag in tags):
                raise RuntimeError('Refusing to delete an ACM certificate without the deployment tag.')
        elif 'ResourceNotFoundException' not in result.stderr:
            raise RuntimeError(f'Could not verify ACM certificate ownership: {result.stderr.strip()}')
        result = subprocess.run(['aws', 'acm', 'delete-certificate', '--certificate-arn', arn, '--output', 'json'],
                                text=True, capture_output=True)
        if result.returncode and 'ResourceNotFoundException' not in result.stderr:
            raise RuntimeError(f'ACM certificate deletion failed: {result.stderr.strip()}')
        state['deleted'] = True
        save(state)


if __name__ == '__main__':
    try:
        if len(sys.argv) == 3 and sys.argv[1] == 'prepare':
            prepare(sys.argv[2])
        elif len(sys.argv) == 2 and sys.argv[1] == 'delete':
            remove()
        elif len(sys.argv) == 2 and sys.argv[1] == 'check-scope':
            if STATE.exists():
                check_scope(json.loads(STATE.read_text(encoding='utf-8')))
            elif CERT.exists() or KEY.exists():
                raise RuntimeError('TLS files exist without metadata; check ACM before continuing.')
            elif (DEPLOYMENT / 'prod.json').exists() and json.loads((DEPLOYMENT / 'prod.json').read_text(encoding='utf-8')).get('certificateArn'):
                raise RuntimeError('TLS metadata is missing for a previously configured certificate; restore it before continuing.')
        else:
            raise ValueError('Usage: prod_tls.py prepare HOSTNAME | delete | check-scope')
    except (OSError, ValueError, KeyError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f'Production TLS error: {error}', file=sys.stderr)
        sys.exit(1)
