#!/usr/bin/env python3
"""Two isolated Syncthing instances on 127.0.0.1: what happens to a link that replaces a
folder (or appears at a new path) on both machines while the folder is paused.

Cases, all made while the folder is paused on both, then resumed:
  1 both:      the folder proj1 removed and the same link put in its place on A and on B
  2 one:       proj2 removed on A and B, the link put only on A
  3 new:       no folder before; the same parents and link made on A and on B (newhost/g/proj3)
  4 ignored:   proj4 holds an ignored node_modules on B; removed and linked only on A

claude-memory-in-project DL #28 (Syncthing 2.1.6, m3, 2026-11-22; two runs, the same): 1 and 3 — the link on both,
no conflict copies; 2 — the link on neither; 4 — B keeps the folder, "contains ignored files".
Run a copy in a scratch directory, not here: it makes the instances' homes a/ and b/ beside itself, listens on
127.0.0.1 ports 28384-28385 and 22101-22102 only, and stops both instances at the end — python3 -I run.py
"""
import json, os, shutil, subprocess, sys, time, urllib.request

BASE = os.path.dirname(os.path.abspath(__file__))
INST = {
    'A': {'gui': 28384, 'listen': 22101, 'key': 'vdx-sttest-a'},
    'B': {'gui': 28385, 'listen': 22102, 'key': 'vdx-sttest-b'},
}
procs = []


def api(n, method, path, body=None):
    i = INST[n]
    req = urllib.request.Request(f"http://127.0.0.1:{i['gui']}{path}", method=method,
                                 headers={'X-API-Key': i['key'], 'Content-Type': 'application/json'},
                                 data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(req, timeout=10) as r:
        t = r.read()
        return json.loads(t) if t.strip() else None


def wait_up(n):
    for _ in range(120):
        try:
            api(n, 'GET', '/rest/system/ping')
            return
        except Exception:
            time.sleep(0.5)
    sys.exit(f'{n} did not start')


def fdir(n):
    return os.path.join(BASE, n.lower(), 'f')


def kind(p):
    if os.path.islink(p):
        return f'link -> {os.readlink(p)}'
    if os.path.isdir(p):
        return 'dir: ' + ', '.join(sorted(os.listdir(p)))
    return 'missing' if not os.path.exists(p) else 'file'


def wait_synced(label, timeout=180):
    end = time.time() + timeout
    while time.time() < end:
        ok = True
        for n, other in (('A', 'B'), ('B', 'A')):
            st = api(n, 'GET', '/rest/db/status?folder=f')
            comp = api(n, 'GET', f"/rest/db/completion?folder=f&device={INST[other]['id']}")
            if st['state'] != 'idle' or st['needTotalItems'] != 0 or comp['completion'] < 100:
                ok = False
        if ok:
            time.sleep(3)  # one more look after a settle
            again = all(api(n, 'GET', '/rest/db/status?folder=f')['needTotalItems'] == 0 for n in 'AB')
            if again:
                print(f'[{label}] synced')
                return True
        time.sleep(1)
    print(f'[{label}] NOT synced in {timeout}s')
    return False


def main():
    for n in 'AB':
        shutil.rmtree(os.path.join(BASE, n.lower()), ignore_errors=True)
        home = os.path.join(BASE, n.lower(), 'home')
        os.makedirs(fdir(n))
        subprocess.run(['syncthing', 'generate', f'--home={home}', '--no-port-probing'], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        INST[n]['id'] = subprocess.run(['syncthing', 'device-id', f'--home={home}'], check=True,
                                       capture_output=True, text=True).stdout.strip()
        env = dict(os.environ, STNOUPGRADE='1')
        p = subprocess.Popen(['syncthing', 'serve', f'--home={home}', '--no-browser', '--no-restart',
                              '--no-upgrade', f"--gui-address=127.0.0.1:{INST[n]['gui']}",
                              f"--gui-apikey={INST[n]['key']}", f"--log-file={home}/log.txt"],
                             env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        procs.append(p)
    for n in 'AB':
        wait_up(n)
    print('versions:', api('A', 'GET', '/rest/system/version')['version'])
    for n, other in (('A', 'B'), ('B', 'A')):
        cfg = api(n, 'GET', '/rest/config')
        o = cfg['options']
        o.update({'listenAddresses': [f"tcp://127.0.0.1:{INST[n]['listen']}"], 'globalAnnounceEnabled': False,
                  'localAnnounceEnabled': False, 'relaysEnabled': False, 'natEnabled': False, 'urAccepted': -1,
                  'crashReportingEnabled': False, 'autoUpgradeIntervalH': 0, 'startBrowser': False})
        cfg['folders'] = [{
            'id': 'f', 'label': 'f', 'path': fdir(n), 'type': 'sendreceive', 'rescanIntervalS': 3600,
            'fsWatcherEnabled': True, 'fsWatcherDelayS': 1,
            'devices': [{'deviceID': INST[n]['id']}, {'deviceID': INST[other]['id']}],
        }]
        cfg['devices'] = [d for d in cfg['devices'] if d['deviceID'] == INST[n]['id']] + [{
            'deviceID': INST[other]['id'], 'name': other, 'addresses': [f"tcp://127.0.0.1:{INST[other]['listen']}"],
            'autoAcceptFolders': False,
        }]
        api(n, 'PUT', '/rest/config', cfg)
    for n in 'AB':
        api(n, 'POST', '/rest/db/ignores?folder=f', {'ignore': ['node_modules']})

    a = fdir('A')
    for proj in ('proj1', 'proj2', 'proj4'):
        os.makedirs(os.path.join(a, 'repo', 'x', proj, 'sub'))
        open(os.path.join(a, 'repo', 'x', proj, 'a.txt'), 'w').write(proj)
        open(os.path.join(a, 'repo', 'x', proj, 'sub', 'b.txt'), 'w').write(proj + ' b')
    api('A', 'POST', '/rest/db/scan?folder=f')
    if not wait_synced('seed'):
        return
    b = fdir('B')
    os.makedirs(os.path.join(b, 'repo', 'x', 'proj4', 'node_modules'))
    open(os.path.join(b, 'repo', 'x', 'proj4', 'node_modules', 'm.js'), 'w').write('m')
    for n in 'AB':
        api(n, 'POST', '/rest/db/scan?folder=f')
    wait_synced('ignored file on B')

    for n in 'AB':
        api(n, 'PATCH', '/rest/config/folders/f', {'paused': True})
    time.sleep(2)

    def link(root, rel, target):
        p = os.path.join(root, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        os.symlink(target, p)

    for root in (a, b):  # case 1, both
        shutil.rmtree(os.path.join(root, 'repo/x/proj1'))
        link(root, 'repo/x/proj1', '../../desk/proj1')
    for root in (a, b):  # case 2, removed on both
        shutil.rmtree(os.path.join(root, 'repo/x/proj2'))
    link(a, 'repo/x/proj2', '../../desk/proj2')  # linked on A only
    link(a, 'repo/newhost/g/proj3', '../../../desk/proj3')  # case 3, new path, A
    time.sleep(1.5)  # B makes its own a moment later, as on another machine
    link(b, 'repo/newhost/g/proj3', '../../../desk/proj3')
    shutil.rmtree(os.path.join(a, 'repo/x/proj4'))  # case 4, A only
    link(a, 'repo/x/proj4', '../../desk/proj4')

    for n in 'AB':
        api(n, 'PATCH', '/rest/config/folders/f', {'paused': False})
    time.sleep(2)
    for n in 'AB':
        api(n, 'POST', '/rest/db/scan?folder=f')
    wait_synced('after the links', timeout=120)
    time.sleep(5)

    for rel in ('repo/x/proj1', 'repo/x/proj2', 'repo/newhost/g/proj3', 'repo/x/proj4'):
        print(f'{rel}:')
        for n in 'AB':
            print(f'   {n}: {kind(os.path.join(fdir(n), rel))}')
    for n in 'AB':
        conflicts = [os.path.join(dp, f) for dp, dn, fn in os.walk(fdir(n)) for f in fn + dn if 'sync-conflict' in f]
        st = api(n, 'GET', '/rest/db/status?folder=f')
        errs = api(n, 'GET', '/rest/folder/errors?folder=f')
        print(f'{n}: conflict copies {conflicts or "none"}; needTotalItems {st["needTotalItems"]}; '
              f'pullErrors {st.get("pullErrors")}; errors {json.dumps(errs.get("errors"))}')


try:
    main()
finally:
    for n in 'AB':
        try:
            api(n, 'POST', '/rest/system/shutdown')
        except Exception:
            pass
    time.sleep(2)
    for p in procs:
        if p.poll() is None:
            p.terminate()
    for p in procs:
        try:
            p.wait(timeout=10)
        except Exception:
            p.kill()
    print('stopped:', [p.poll() for p in procs])
