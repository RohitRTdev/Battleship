"""Run a production-only load test, or regenerate saved graphs with --plot-only."""
from __future__ import annotations

import argparse
import asyncio
import csv
import json
import math
import os
import random
import secrets
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import aiohttp
import boto3

from common.bot_names import bot_password
from play_bot import random_fleet

ROOT = Path(__file__).resolve().parent.parent
FIELDS = ['repetition', 'level', 'warmup', 'target_rps', 'scheduled_utc', 'sent_utc',
          'completed_utc', 'schedule_delay_ms', 'latency_ms', 'kind', 'status', 'failure']


def utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds')


def render(folder: Path) -> None:
    """Create the three graphs from a saved run without contacting AWS."""
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt

    data = json.loads((folder / 'summary.json').read_text(encoding='utf-8'))
    levels = [level for level in data['levels'] if not level.get('warmup') and level['attempted']]
    if not levels:
        raise ValueError('No measured load levels to plot')

    fig, ax = plt.subplots()
    for repetition in sorted({level['repetition'] for level in levels}):
        # Plot in target-rate order; achieved throughput remains in summary.json.
        group = sorted((level for level in levels if level['repetition'] == repetition),
                       key=lambda level: level['target_rps'])
        for key, style in [('mean_ms', '-'), ('p95_ms', '--'), ('p99_ms', ':')]:
            points = [(level['target_rps'], level[key] / 1000) for level in group if level[key] is not None]
            if points:
                ax.plot(*zip(*points), style, marker='.', label=f'{key[:-3]} (run {repetition})')
    ax.set(xlabel='Target requests/s', ylabel='Latency (seconds)', title='HTTP response latency')
    ax.legend(); ax.grid(True, alpha=.3); fig.tight_layout()
    fig.savefig(folder / 'latency.png', dpi=150); plt.close(fig)

    fig, ax = plt.subplots()
    for repetition in sorted({level['repetition'] for level in levels}):
        group = sorted((level for level in levels if level['repetition'] == repetition),
                       key=lambda level: level['target_rps'])
        ax.plot([level['target_rps'] for level in group],
                [100 * level['error_rate'] for level in group], marker='.', label=f'Run {repetition}')
    ax.set(xlabel='Target requests/s', ylabel='5xx + transport failures (%)', title='Error rate')
    ax.legend(); ax.grid(True, alpha=.3); fig.tight_layout()
    fig.savefig(folder / 'error_rate.png', dpi=150); plt.close(fig)

    fig, ax = plt.subplots(figsize=(11, 5))
    samples = [sample for sample in data.get('ecs_samples', []) if 'desired' in sample]
    if samples:
        times = [datetime.fromisoformat(sample['timestamp']) for sample in samples]
        for key in ('desired', 'running', 'pending'):
            ax.step(times, [sample[key] for sample in samples], where='post', label=key)
        ax.legend()
    else:
        ax.text(.5, .5, 'No ECS samples available', ha='center', transform=ax.transAxes)
    for level in levels:
        start, end = (datetime.fromisoformat(level[key]) for key in ('start_utc', 'end_utc'))
        ax.axvspan(start, end, alpha=.08, color='blue')
        ax.axvline(start, color='grey', alpha=.35, linewidth=.6)
        ax.text(start, .98, f"{level['target_rps']:g}", rotation=90, va='top', fontsize=7,
                transform=ax.get_xaxis_transform())
    ax.set(xlabel='UTC (labels show target req/s)', ylabel='ECS tasks', title='Task counts and load levels')
    ax.grid(True, alpha=.3); fig.autofmt_xdate(); fig.tight_layout()
    fig.savefig(folder / 'ecs_scaling.png', dpi=150); plt.close(fig)


def percentile(values: list[float], p: float) -> float | None:
    if not values:
        return None
    values = sorted(values)
    return values[max(0, math.ceil(p * len(values)) - 1)]


def summarize(rows: list[dict], duration: float) -> dict:
    latencies = [r['latency_ms'] for r in rows if r['status'] is not None]
    accepted = [r['latency_ms'] for r in rows if r['kind'] == 'fire' and r['status'] is not None and 200 <= r['status'] < 300]
    statuses = [r['status'] for r in rows if r['status'] is not None]
    failures = [r['failure'] for r in rows if r['failure']]
    errors_5xx = sum(500 <= s < 600 for s in statuses)
    count = len(rows)
    return {'attempted': count, 'achieved_rps': count / duration if duration else 0,
            'mean_ms': sum(latencies) / len(latencies) if latencies else None,
            'p50_ms': percentile(latencies, .50), 'p95_ms': percentile(latencies, .95),
            'p99_ms': percentile(latencies, .99), 'accepted_fire_p99_ms': percentile(accepted, .99),
            'accepted_fire': len(accepted), 'rejected_fire': sum(r['kind'] == 'fire' and r['status'] is not None and not 200 <= r['status'] < 300 for r in rows),
            'http_status_counts': {str(s): statuses.count(s) for s in sorted(set(statuses))},
            'http_5xx': errors_5xx, 'timeouts': failures.count('timeout'),
            'other_transport': len(failures) - failures.count('timeout'),
            'error_rate': (errors_5xx + len(failures)) / count if count else 0,
            'max_schedule_delay_ms': max((r['schedule_delay_ms'] for r in rows), default=0),
            'late_over_10ms': sum(r['schedule_delay_ms'] > 10 for r in rows)}


def env_values() -> dict[str, str]:
    result = {}
    path = ROOT / '.env'
    if path.exists():
        for line in path.read_text(encoding='utf-8').splitlines():
            k, sep, v = line.partition('=')
            if sep and not k.startswith('#'):
                result[k.strip()] = v.strip().strip('\"\'')
    return result


def positive(value: str) -> float:
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError('must be a positive finite number')
    return number


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--matches', type=int, help='Number of concurrent matches (required for a load test)')
    p.add_argument('--max-rps', type=positive, help='Maximum request rate (required for a load test)')
    p.add_argument('--plot-only', type=Path, metavar='RESULTS_DIR', help='Regenerate graphs from an existing run without starting a load test')
    p.add_argument('--start-rps', type=positive, default=10)
    p.add_argument('--step-rps', type=positive, default=10)
    p.add_argument('--duration', type=positive, default=180, help='Seconds per level (default 180)')
    p.add_argument('--warmup', type=float, default=30, help='Warm-up seconds; 0 disables')
    p.add_argument('--repetitions', type=int, default=1)
    p.add_argument('--seed', type=int, default=42)
    p.add_argument('--fire-fraction', type=float, default=.5)
    p.add_argument('--timeout', type=positive, default=5)
    p.add_argument('--sample-interval', type=positive, default=15)
    p.add_argument('--setup-workers', type=int, default=8)
    p.add_argument('--cluster', help='ECS cluster name; defaults to PROD_STACK_NAME from .env')
    p.add_argument('--output', type=Path, default=ROOT / 'load-test-results')
    return p


async def setup_matches(session, args, cognito, pool, client_id, run_id, created_matches):
    sem = asyncio.Semaphore(args.setup_workers)
    seed = os.environ.get('BATTLESHIP_BOT_PASSWORD_SEED', 'battleship-local-bot-seed')
    async def user(index):
        name = f'loadtest-{run_id}-{index:06d}'
        password = bot_password(name, seed)
        async with sem:
            def provision():
                try:
                    cognito.admin_create_user(UserPoolId=pool, Username=name, MessageAction='SUPPRESS')
                except cognito.exceptions.UsernameExistsException:
                    # Never reset an existing account's password.
                    pass
                else:
                    cognito.admin_set_user_password(UserPoolId=pool, Username=name, Password=password, Permanent=True)
                response = cognito.initiate_auth(AuthFlow='USER_PASSWORD_AUTH', ClientId=client_id,
                    AuthParameters={'USERNAME': name, 'PASSWORD': password})['AuthenticationResult']
                return {'name': name, 'token': response['AccessToken'], 'expires_at': time.monotonic()+response['ExpiresIn']}
            return await asyncio.to_thread(provision)

    users = await asyncio.gather(*(user(i) for i in range(args.matches * 2)))
    print(f'Provisioned and logged in {len(users)} users', flush=True)

    async def request(method, path, user, body=None, expected=200):
        async with session.request(method, args.url.rstrip('/') + path, headers={'Authorization': 'Bearer '+user['token']}, json=body) as response:
            content = await response.text()
            if response.status != expected:
                raise RuntimeError(f'Setup {method} {path}: HTTP {response.status}: {content[:300]}')
            return json.loads(content)

    async def match(i):
        async with sem:
            a, b = users[2*i:2*i+2]
            created = await request('POST', '/api/backend/games', a, {}, 201)
            code = created['game']['gameCode']
            created_matches.append((a, code))
            await request('POST', f'/api/backend/games/{code}/join', b, {})
            rng = random.Random(args.seed + i)
            await request('PUT', f'/api/backend/games/{code}/fleet', a, {'ships': random_fleet(rng)})
            result = await request('PUT', f'/api/backend/games/{code}/fleet', b, {'ships': random_fleet(rng)})
            game = result['game']
            if game.get('status') != 'ACTIVE' or game.get('turnDeadlineAt'):
                raise RuntimeError(f'Match {code} is not active with timers disabled; deploy with DISABLE_TIMEOUT=true')
            return [(a, code), (b, code)]
    matches = await asyncio.gather(*(match(i) for i in range(args.matches)), return_exceptions=True)
    errors = [result for result in matches if isinstance(result, BaseException)]
    if errors:
        raise errors[0]
    print(f'{len(matches)}/{args.matches} matches active; timeouts disabled', flush=True)
    return [player for pair in matches for player in pair], cognito, client_id, seed


async def finish_matches(session, args, matches, cognito, client_id, seed):
    """End games created in this run, including incomplete setup games."""
    sem = asyncio.Semaphore(args.setup_workers)

    async def finish(user, code):
        async with sem:
            try:
                if user['expires_at'] - time.monotonic() < 60:
                    def login_again():
                        return cognito.initiate_auth(AuthFlow='USER_PASSWORD_AUTH', ClientId=client_id,
                            AuthParameters={'USERNAME': user['name'], 'PASSWORD': bot_password(user['name'], seed)})['AuthenticationResult']
                    auth = await asyncio.to_thread(login_again)
                    user.update(token=auth['AccessToken'], expires_at=time.monotonic() + auth['ExpiresIn'])
                headers = {'Authorization': 'Bearer ' + user['token']}
                url = args.url.rstrip('/') + f'/api/backend/games/{code}'
                async with session.get(url, headers=headers) as response:
                    if response.status != 200:
                        raise RuntimeError(f'game lookup returned HTTP {response.status}')
                    status = (await response.json())['game']['status']
                if status == 'FINISHED':
                    return {'game_code': code, 'result': 'already_finished'}
                if status not in ('ACTIVE', 'WAITING', 'PLACEMENT'):
                    raise RuntimeError(f'unexpected game status {status!r}')
                action = 'surrender' if status == 'ACTIVE' else 'cancel'
                async with session.post(f'{url}/{action}', headers=headers, json={}) as response:
                    if response.status != 200:
                        raise RuntimeError(f'{action} returned HTTP {response.status}')
                    await response.read()
                return {'game_code': code, 'result': 'surrendered' if action == 'surrender' else 'cancelled'}
            except Exception as exc:
                return {'game_code': code, 'result': 'failed', 'error': str(exc)}

    return await asyncio.gather(*(finish(user, code) for user, code in matches))


async def refresh_users(players, cognito, client_id, seed, workers, minimum_lifetime):
    sem = asyncio.Semaphore(workers)
    async def refresh(user):
        if user['expires_at'] - time.monotonic() > minimum_lifetime:
            return
        async with sem:
            def call():
                return cognito.initiate_auth(AuthFlow='USER_PASSWORD_AUTH', ClientId=client_id,
                    AuthParameters={'USERNAME': user['name'], 'PASSWORD': bot_password(user['name'], seed)})['AuthenticationResult']
            result = await asyncio.to_thread(call)
            user.update(token=result['AccessToken'], expires_at=time.monotonic()+result['ExpiresIn'])
    await asyncio.gather(*(refresh(user) for user, _ in players))


async def sample_ecs(ecs, cluster, interval, samples, stop):
    while not stop.is_set():
        sample = {'timestamp': utc()}
        try:
            result = await asyncio.to_thread(ecs.describe_services, cluster=cluster, services=['backend'])
            if result.get('failures') or not result.get('services'):
                raise RuntimeError(str(result.get('failures') or 'service not found'))
            s = result['services'][0]
            sample.update(desired=s['desiredCount'], running=s['runningCount'], pending=s['pendingCount'])
            print(f"{sample['timestamp']} ECS desired={sample['desired']} running={sample['running']} pending={sample['pending']}", flush=True)
        except Exception as exc:
            sample['error'] = str(exc)
            print(f"{sample['timestamp']} ECS sampling failed: {exc}", file=sys.stderr, flush=True)
        samples.append(sample)
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval)
        except asyncio.TimeoutError:
            pass


async def run_level(session, args, players, rate, duration, repetition, index, warmup, writer, raw_file):
    start_mono, start_wall = time.monotonic(), time.time()
    start = datetime.fromtimestamp(start_wall, timezone.utc).isoformat(timespec='milliseconds')
    print(f"{start} START {'warmup' if warmup else 'level '+str(index)}: {rate:g} req/s", flush=True)
    rows, tasks = [], set()
    rng = random.Random(args.seed + repetition*100000 + index)

    async def send(number, scheduled):
        user, code = players[number % len(players)]
        kind = 'fire' if rng.random() < args.fire_fraction else 'read'
        sent_mono = time.monotonic()
        sent_wall = utc()
        row = {'repetition': repetition, 'level': index, 'warmup': warmup, 'target_rps': rate,
               'scheduled_utc': datetime.fromtimestamp(start_wall + scheduled, timezone.utc).isoformat(timespec='milliseconds'),
               'sent_utc': sent_wall, 'schedule_delay_ms': max(0, (sent_mono-start_mono-scheduled)*1000),
               'kind': kind, 'status': None, 'failure': ''}
        try:
            path = f'/api/backend/games/{code}' + ('/fire' if kind == 'fire' else '')
            async with session.request('POST' if kind == 'fire' else 'GET', args.url.rstrip('/')+path,
                    headers={'Authorization': 'Bearer '+user['token'], 'Cache-Control': 'no-store'},
                    json={'coordinate': {'row': 0, 'column': 0}} if kind == 'fire' else None,
                    timeout=aiohttp.ClientTimeout(total=args.timeout)) as response:
                await response.read()
                row['status'] = response.status
        except (asyncio.TimeoutError, TimeoutError):
            row['failure'] = 'timeout'
        except (aiohttp.ClientError, OSError) as exc:
            row['failure'] = type(exc).__name__
        row['latency_ms'] = (time.monotonic() - sent_mono)*1000
        row['completed_utc'] = utc()
        rows.append(row)
        writer.writerow(row)

    try:
        number = 0
        while number / rate < duration:
            due = start_mono + number / rate
            await asyncio.sleep(max(0, due - time.monotonic()))
            # Never dispatch a backlog after the level's scheduled end.
            if time.monotonic() >= start_mono + duration:
                break
            task = asyncio.create_task(send(number, number/rate))
            tasks.add(task)
            task.add_done_callback(tasks.discard)
            number += 1
        await asyncio.sleep(max(0, start_mono + duration - time.monotonic()))
        actual_duration = time.monotonic() - start_mono
        end = utc()
        if tasks:
            await asyncio.gather(*tasks)
    except BaseException:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise
    raw_file.flush()
    summary = {'repetition': repetition, 'level': index, 'warmup': warmup, 'target_rps': rate,
               'start_utc': start, 'end_utc': end, 'actual_duration_seconds': actual_duration,
               **summarize(rows, actual_duration)}
    print(f"{end} END {rate:g} req/s: achieved={summary['achieved_rps']:.2f}, "
          f"mean={summary['mean_ms']} ms, p95={summary['p95_ms']} ms, p99={summary['p99_ms']} ms, "
          f"errors={100*summary['error_rate']:.2f}%", flush=True)
    return summary


async def verify_active(session, args, players):
    sem = asyncio.Semaphore(args.setup_workers)
    async def check(user, code):
        async with sem:
            async with session.get(args.url.rstrip('/') + f'/api/backend/games/{code}',
                    headers={'Authorization': 'Bearer '+user['token']}) as response:
                if response.status != 200:
                    raise RuntimeError(f'Checking match {code} returned HTTP {response.status}')
                game = (await response.json())['game']
                if game.get('status') != 'ACTIVE' or game.get('turnDeadlineAt'):
                    raise RuntimeError(f'Match {code} is no longer active with timeouts disabled')
    await asyncio.gather(*(check(*players[i]) for i in range(0, len(players), 2)))


async def run(args):
    env = env_values()
    for key in ('AWS_PROFILE', 'AWS_REGION'):
        if env.get(key):
            os.environ.setdefault(key, env[key])
    config = json.loads((ROOT / '.deployment' / 'prod.json').read_text(encoding='utf-8'))
    if not isinstance(config.get('url'), str) or not config['url'].strip():
        raise ValueError('.deployment/prod.json does not contain a production URL')
    args.url = config['url'].strip().rstrip('/')
    cluster = args.cluster or os.environ.get('PROD_STACK_NAME') or env.get('PROD_STACK_NAME')
    if not cluster:
        raise ValueError('Set PROD_STACK_NAME in .env or supply --cluster')
    session_aws = boto3.Session(region_name=config['region'])
    cognito = session_aws.client('cognito-idp')
    ecs = session_aws.client('ecs')
    autoscaling = session_aws.client('application-autoscaling')
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + secrets.token_hex(4)
    folder = args.output / run_id
    folder.mkdir(parents=True, exist_ok=False)
    metadata = {'schema_version': 1, 'run_id': run_id, 'started_utc': utc(),
                'config': {**vars(args), 'output': str(args.output), 'cluster': cluster},
                'levels': [], 'ecs_samples': [], 'scaling_activities': [], 'cleanup': [], 'warnings': []}
    stop = asyncio.Event()
    sampler = asyncio.create_task(sample_ecs(ecs, cluster, args.sample_interval, metadata['ecs_samples'], stop))
    failure = None
    try:
        timeout = aiohttp.ClientTimeout(total=max(args.timeout, 30))
        async with aiohttp.ClientSession(timeout=timeout, connector=aiohttp.TCPConnector(limit=0)) as http:
            created_matches = []
            client_id = config['userPoolClientId']
            seed = os.environ.get('BATTLESHIP_BOT_PASSWORD_SEED', 'battleship-local-bot-seed')
            try:
                players, cognito, client_id, seed = await setup_matches(http, args, cognito, config['userPoolId'], client_id, run_id.lower(), created_matches)
                with (folder / 'requests.csv').open('w', newline='', encoding='utf-8') as raw:
                    writer = csv.DictWriter(raw, fieldnames=FIELDS)
                    writer.writeheader()
                    if args.warmup:
                        await refresh_users(players, cognito, client_id, seed, args.setup_workers, args.warmup + args.timeout + 60)
                        metadata['levels'].append(await run_level(http, args, players, args.start_rps, args.warmup, 0, 0, True, writer, raw))
                    rates = []
                    rate = args.start_rps
                    while rate < args.max_rps:
                        rates.append(rate)
                        rate += args.step_rps
                    rates.append(args.max_rps)
                    for repetition in range(1, args.repetitions + 1):
                        for index, rate in enumerate(rates, 1):
                            await refresh_users(players, cognito, client_id, seed, args.setup_workers, args.duration + args.timeout + 60)
                            await verify_active(http, args, players)
                            metadata['levels'].append(await run_level(http, args, players, rate, args.duration, repetition, index, False, writer, raw))
                            (folder / 'summary.json').write_text(json.dumps(metadata, indent=2, default=str), encoding='utf-8')
            finally:
                if created_matches:
                    print(f'Ending {len(created_matches)} test matches...', flush=True)
                    metadata['cleanup'] = await finish_matches(http, args, created_matches, cognito, client_id, seed)
                    failures = [item for item in metadata['cleanup'] if item['result'] == 'failed']
                    print(f"Match cleanup: {len(created_matches) - len(failures)} ended or already finished, {len(failures)} failed", flush=True)
                    if failures:
                        metadata['warnings'].append(f"Failed to end {len(failures)} matches; see cleanup in summary.json")
                        failure = RuntimeError(f"Failed to end {len(failures)} matches; see cleanup in summary.json")
                        for item in failures:
                            print(f"Could not end match {item['game_code']}: {item['error']}", file=sys.stderr, flush=True)
    except Exception as exc:
        failure = exc
        metadata['warnings'].append(f'Run failed: {exc}')
    finally:
        stop.set()
        await sampler
        try:
            result = await asyncio.to_thread(autoscaling.describe_scaling_activities,
                ServiceNamespace='ecs', ResourceId=f'service/{cluster}/backend',
                ScalableDimension='ecs:service:DesiredCount', MaxResults=50)
            start = datetime.fromisoformat(metadata['started_utc'])
            metadata['scaling_activities'] = [x for x in result.get('ScalingActivities', [])
                if x.get('EndTime', x['StartTime']) >= start]
        except Exception as exc:
            metadata['warnings'].append(f'Scaling activity collection failed: {exc}')
        metadata['finished_utc'] = utc()
        (folder / 'summary.json').write_text(json.dumps(metadata, indent=2, default=str), encoding='utf-8')
        if any(not x['warmup'] and x['attempted'] for x in metadata['levels']):
            render(folder)
        print(f'Results: {folder.resolve()}', flush=True)
    if failure:
        raise failure
    for key, threshold in [('p95_ms', 2000), ('mean_ms', 1000)]:
        crossed = next((x for x in metadata['levels'] if not x['warmup'] and x[key] is not None and x[key] > threshold), None)
        print(f"{key} > {threshold} ms: " + (f"{crossed['achieved_rps']:.2f} achieved req/s (target {crossed['target_rps']:g}, repetition {crossed['repetition']})" if crossed else 'not observed'))


def main():
    p = parser()
    args = p.parse_args()
    if args.plot_only is not None:
        try:
            render(args.plot_only)
        except (OSError, ValueError, KeyError) as exc:
            print(f'Could not generate graphs: {exc}', file=sys.stderr)
            return 1
        print(f'Graphs written to {args.plot_only.resolve()}')
        return 0
    if args.matches is None or args.max_rps is None:
        p.error('--matches and --max-rps are required for a load test')
    if args.matches < 1 or args.repetitions < 1 or args.setup_workers < 1:
        p.error('matches, repetitions, and setup-workers must be positive')
    if args.start_rps > args.max_rps:
        p.error('start-rps must not exceed max-rps')
    if not 0 <= args.fire_fraction <= 1 or not math.isfinite(args.fire_fraction):
        p.error('fire-fraction must be between 0 and 1')
    if not math.isfinite(args.warmup) or args.warmup < 0:
        p.error('warmup must be nonnegative')
    if max(args.duration, args.warmup) + args.timeout + 60 >= 3600:
        p.error('a level plus timeout must fit within the one-hour Cognito token lifetime')
    try:
        asyncio.run(run(args))
    except (Exception, KeyboardInterrupt) as exc:
        print(f'Load test stopped: {exc}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
