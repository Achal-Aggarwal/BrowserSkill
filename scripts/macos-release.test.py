import importlib.util
import io
import json
from pathlib import Path
import struct
import tarfile
import tempfile
import unittest
from unittest.mock import patch, MagicMock
import zipfile

spec = importlib.util.spec_from_file_location('macos', Path(__file__).with_name('macos-release.py'))
mac = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mac)


def executable(target, signature=False):
    header = struct.pack('<8I', 0xfeedfacf, mac.TARGETS[target][0], 0, 2, 1, 72, 0, 0)
    segment = struct.pack('<II16s4Q4I', 0x19, 72, b'__LINKEDIT', 4096, 4096, 256, 256, 1, 1, 0, 0)
    data = bytearray(header + segment + b'\0' * (512 - len(header + segment)))
    data[300:400] = b'X' * 100
    if signature:
        struct.pack_into('<II', data, 16, 2, 88)
        struct.pack_into('<II', data, 104, 0x1d, 16)
        struct.pack_into('<II', data, 112, 512, 16)
        struct.pack_into('<Q', data, 80, 272)
        data += b'S' * 16
    return data


def tar(data, name='bsk', kind=tarfile.REGTYPE):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w:gz') as archive:
        entry = tarfile.TarInfo(name)
        entry.type = kind
        entry.size = len(data) if kind == tarfile.REGTYPE else 0
        archive.addfile(entry, io.BytesIO(data))
    return stream.getvalue()


class MacReleaseTests(unittest.TestCase):
    def test_signature_can_be_added_or_replaced_without_changing_program(self):
        for target in mac.TARGETS:
            original, signed = executable(target), executable(target, True)
            mac.same_executable(original, signed, target)
            replaced = bytearray(signed)
            replaced[-16:] = b'T' * 16
            mac.same_executable(signed, replaced, target)

    def test_rejects_modified_code_headers_segments_padding_and_appended_data(self):
        target = 'aarch64-apple-darwin'
        original, signed = executable(target), executable(target, True)
        for offset in [4, 12, 24, 60, 64, 72, 120, 300, 400]:
            changed = bytearray(signed)
            changed[offset] ^= 1
            with self.subTest(offset=offset), self.assertRaises((ValueError, struct.error)):
                mac.same_executable(original, changed, target)
        with self.assertRaises(ValueError):
            mac.same_executable(original, signed + b'extra', target)
        with self.assertRaises(ValueError):
            mac.same_executable(original, original, target)
        with self.assertRaises(ValueError):
            mac.same_executable(original, signed, 'x86_64-apple-darwin')

    def test_tar_never_extracts_paths_or_links(self):
        self.assertEqual(mac.unpack_tar(tar(b'test')), b'test')
        for name, kind in [('../bsk', tarfile.REGTYPE), ('bsk', tarfile.SYMTYPE), ('bsk', tarfile.LNKTYPE)]:
            with self.subTest(name=name, kind=kind), self.assertRaises(ValueError):
                mac.unpack_tar(tar(b'', name, kind))

    def test_notary_acceptance_must_cover_each_actual_code_hash(self):
        targets = {t: {'cdhash': str(i) * 40} for i, t in enumerate(mac.TARGETS)}
        log = {'jobId': 'submission', 'status': 'Accepted', 'statusCode': 0,
               'ticketContents': [{'arch': arch, 'cdhash': targets[t]['cdhash'], 'path': f'notarization.zip/{t}/bsk'}
                                  for t, (_, arch) in mac.TARGETS.items()]}
        mac.check_notary_log(log, 'submission', targets)
        for changes in [{'jobId': 'other'}, {'status': 'Invalid'}, {'statusCode': 4000}, {'ticketContents': log['ticketContents'][:1]}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                mac.check_notary_log({**log, **changes}, 'submission', targets)

    def test_verification_mode_cannot_return_assets(self):
        with patch.object(mac, 'read_json', return_value={'verification_only': True}):
            api = MagicMock()
            with self.assertRaises(ValueError):
                mac.return_signed(None, api)
            api.request.assert_not_called()
            api.upload.assert_not_called()

    def test_subprocess_errors_do_not_include_credential_arguments_or_output(self):
        response = MagicMock(returncode=1, stdout='secret', stderr='secret')
        with patch.object(mac.subprocess, 'run', return_value=response):
            with self.assertRaises(ValueError) as caught:
                mac.command(['xcrun', 'notarytool', '--password', 'secret'])
            self.assertNotIn('secret', str(caught.exception))

    def test_signature_requires_identity_timestamp_runtime_and_no_entitlements(self):
        info = f'Authority={mac.IDENTITY}\nTeamIdentifier={mac.TEAM}\nIdentifier={mac.IDENTIFIER}\nTimestamp=Oct 28\nflags=0x10000(runtime)\nCDHash={"a" * 40}\n'
        def run(argv):
            if '--entitlements' in argv:
                return '', ''
            return '', info
        with patch.object(mac, 'command', side_effect=run):
            self.assertEqual(mac.verify_signature('bsk', notarized=True), 'a' * 40)
            for value in [info.replace(mac.TEAM, 'WRONG'), info.replace('Timestamp=', 'NoTimestamp='), info.replace('runtime', 'adhoc')]:
                with patch.object(mac, 'command', return_value=('', value)), self.assertRaises(ValueError):
                    mac.verify_signature('bsk')

    def test_final_publication_requires_matching_mac_run_and_verified_binary(self):
        state = {k: str(i) for i, k in enumerate((*mac.KEYS, 'release_id'))}
        state['tag'] = 'cli-v1.2.3'
        manifest = {**state, 'verification_only': False, 'notary_status': 'Accepted',
                    'targets': {t: {'signed_sha256': mac.digest(b'signed')} for t in mac.TARGETS}}
        with patch.object(mac, 'read_json', return_value=manifest), patch.object(Path, 'read_bytes', return_value=tar(b'signed')):
            mac.check_final(state)
            with self.assertRaises(ValueError):
                mac.check_final({**state, 'run_attempt': 'other'})
            with patch.object(Path, 'read_bytes', return_value=tar(b'unsigned')), self.assertRaises(ValueError):
                mac.check_final(state)


if __name__ == '__main__':
    unittest.main()
