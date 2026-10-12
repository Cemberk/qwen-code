/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openBrowserSecurely } from './secure-browser-launcher.js';

const REPORT_PATH = resolve('report.html');
const REPORT_URL = pathToFileURL(REPORT_PATH).href;

function openReport(url = REPORT_URL) {
  return openBrowserSecurely(url, { allowedFilePaths: [fileURLToPath(url)] });
}

// Create mock function using vi.hoisted
const mockExecFile = vi.hoisted(() => vi.fn());
const mockSpawn = vi.hoisted(() =>
  vi.fn(() => {
    const child: {
      once: ReturnType<typeof vi.fn>;
      unref: ReturnType<typeof vi.fn>;
    } = {
      once: vi.fn((event: string, callback: () => void) => {
        if (event === 'spawn') {
          callback();
        }
        return child;
      }),
      unref: vi.fn(),
    };
    return child;
  }),
);

// Mock modules
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: mockSpawn,
}));
vi.mock('node:util', () => ({
  promisify: () => mockExecFile,
}));

describe('secure-browser-launcher', () => {
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });
    mockSpawn.mockImplementation(() => {
      const child: {
        once: ReturnType<typeof vi.fn>;
        unref: ReturnType<typeof vi.fn>;
      } = {
        once: vi.fn((event: string, callback: () => void) => {
          if (event === 'spawn') {
            callback();
          }
          return child;
        }),
        unref: vi.fn(),
      };
      return child;
    });
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    vi.stubEnv('BROWSER', '');
    vi.stubEnv('CI', '');
    vi.stubEnv('DEBIAN_FRONTEND', '');
    vi.stubEnv('SSH_CONNECTION', '');
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
    vi.unstubAllEnvs();
  });

  function setPlatform(platform: string) {
    Object.defineProperty(process, 'platform', {
      value: platform,
      configurable: true,
    });
  }

  describe('URL validation', () => {
    it('should open an allow-listed local file URL', async () => {
      setPlatform('darwin');
      await openReport();
      expect(mockExecFile).toHaveBeenCalledWith(
        'open',
        [REPORT_URL],
        expect.any(Object),
      );
    });

    it('should never open remote or non-file URLs', async () => {
      for (const url of [
        'http://example.com',
        'https://example.com/report.html',
        'http://127.0.0.1:8080/',
        'javascript:alert(1)',
        'ftp://example.com',
        'data:text/html,hi',
      ]) {
        await expect(
          openBrowserSecurely(url, { allowedFilePaths: [REPORT_PATH] }),
        ).rejects.toThrow('Unsafe protocol');
      }
      expect(mockExecFile).not.toHaveBeenCalled();
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it('should reject file URLs that name a remote host', async () => {
      await expect(
        openBrowserSecurely('file://fileserver.example/share/report.html', {
          allowedFilePaths: ['/share/report.html'],
        }),
      ).rejects.toThrow();
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('should restrict file URLs to the caller allow-list', async () => {
      const otherPath = resolve('other.html');

      await expect(
        openBrowserSecurely(pathToFileURL(otherPath).href, {
          allowedFilePaths: [REPORT_PATH],
        }),
      ).rejects.toThrow('allowed file set');
      await expect(
        openBrowserSecurely(REPORT_URL, { allowedFilePaths: [] }),
      ).rejects.toThrow('allowed file set');
    });

    it('should reject invalid URLs', async () => {
      await expect(
        openBrowserSecurely('not-a-url', { allowedFilePaths: [REPORT_PATH] }),
      ).rejects.toThrow('Invalid URL');
      await expect(
        openBrowserSecurely('', { allowedFilePaths: [REPORT_PATH] }),
      ).rejects.toThrow('Invalid URL');
    });

    it('should reject URLs with control characters', async () => {
      for (const suffix of ['\nmalicious-command', '\rmalicious', '\x00']) {
        await expect(
          openBrowserSecurely(`${REPORT_URL}${suffix}`, {
            allowedFilePaths: [REPORT_PATH],
          }),
        ).rejects.toThrow();
      }
      expect(mockExecFile).not.toHaveBeenCalled();
    });
  });

  describe('Command injection prevention', () => {
    it('should prevent PowerShell command injection on Windows', async () => {
      setPlatform('win32');

      const maliciousUrl = pathToFileURL(
        resolve(
          "report-$(Invoke-Expression([System.Convert]::FromBase64String('Y2FsYy5leGU='))).html",
        ),
      ).href;

      await openReport(maliciousUrl);

      expect(mockExecFile).toHaveBeenCalledWith(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle',
          'Hidden',
          '-Command',
          `Start-Process '${maliciousUrl.replace(/'/g, "''")}'`,
        ],
        expect.any(Object),
      );
    });

    it('should handle URLs with special shell characters safely', async () => {
      setPlatform('darwin');

      const urlsWithSpecialChars = [
        'report&other=$value.html',
        'report;command.html',
        'report-$(whoami).html',
        'report|pipe.html',
      ].map((name) => pathToFileURL(resolve(name)).href);

      for (const url of urlsWithSpecialChars) {
        await openReport(url);
        expect(mockExecFile).toHaveBeenCalledWith(
          'open',
          [url],
          expect.any(Object),
        );
      }
    });

    it('should properly escape single quotes in URLs on Windows', async () => {
      setPlatform('win32');

      const urlWithSingleQuotes = pathToFileURL(
        resolve("O'Brien's report.html"),
      ).href;
      await openReport(urlWithSingleQuotes);

      expect(mockExecFile).toHaveBeenCalledWith(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle',
          'Hidden',
          '-Command',
          `Start-Process '${urlWithSingleQuotes.replace(/'/g, "''")}'`,
        ],
        expect.any(Object),
      );
      expect(urlWithSingleQuotes).toContain("'");
    });
  });

  describe('Platform-specific behavior', () => {
    it('should use correct command on macOS', async () => {
      setPlatform('darwin');
      await openReport();
      expect(mockExecFile).toHaveBeenCalledWith(
        'open',
        [REPORT_URL],
        expect.any(Object),
      );
    });

    it('should use PowerShell on Windows', async () => {
      setPlatform('win32');
      await openReport();
      expect(mockExecFile).toHaveBeenCalledWith(
        'powershell.exe',
        expect.arrayContaining(['-Command', `Start-Process '${REPORT_URL}'`]),
        expect.any(Object),
      );
    });

    it('should use xdg-open on Linux', async () => {
      setPlatform('linux');
      vi.stubEnv('DISPLAY', ':1');
      await openReport();
      expect(mockExecFile).toHaveBeenCalledWith(
        'xdg-open',
        [REPORT_URL],
        expect.any(Object),
      );
    });

    it('should throw on unsupported platforms', async () => {
      setPlatform('aix');
      await expect(openReport()).rejects.toThrow('Unsupported platform');
    });

    it('should prefer BROWSER when it is configured', async () => {
      setPlatform('linux');
      vi.stubEnv('DISPLAY', ':1');
      vi.stubEnv('BROWSER', 'firefox --new-tab');

      await openReport();

      expect(mockSpawn).toHaveBeenCalledWith(
        'firefox',
        ['--new-tab', REPORT_URL],
        expect.objectContaining({
          detached: true,
          stdio: 'ignore',
        }),
      );
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('should substitute the BROWSER placeholder instead of appending the URL', async () => {
      setPlatform('linux');
      vi.stubEnv('DISPLAY', ':1');
      vi.stubEnv('BROWSER', 'firefox --new-tab %s');

      await openReport();

      expect(mockSpawn).toHaveBeenCalledWith(
        'firefox',
        ['--new-tab', REPORT_URL],
        expect.any(Object),
      );
    });

    it('should substitute BROWSER placeholders literally', async () => {
      setPlatform('linux');
      vi.stubEnv('DISPLAY', ':1');
      vi.stubEnv('BROWSER', 'firefox --new-tab %s');
      const url = pathToFileURL(resolve('callback$&state.html')).href;
      expect(url).toContain('$&');

      await openReport(url);

      expect(mockSpawn).toHaveBeenCalledWith(
        'firefox',
        ['--new-tab', url],
        expect.any(Object),
      );
    });

    it('should parse quoted arguments inside BROWSER tokens', async () => {
      setPlatform('linux');
      vi.stubEnv('DISPLAY', ':1');
      vi.stubEnv(
        'BROWSER',
        'chromium --user-data-dir="/tmp/my profile" --new-tab %s',
      );

      await openReport();

      expect(mockSpawn).toHaveBeenCalledWith(
        'chromium',
        ['--user-data-dir=/tmp/my profile', '--new-tab', REPORT_URL],
        expect.any(Object),
      );
    });

    it('should parse quoted command paths in BROWSER', async () => {
      setPlatform('linux');
      vi.stubEnv('DISPLAY', ':1');
      vi.stubEnv('BROWSER', '"/opt/my browser/chromium" --new-tab %s');

      await openReport();

      expect(mockSpawn).toHaveBeenCalledWith(
        '/opt/my browser/chromium',
        ['--new-tab', REPORT_URL],
        expect.any(Object),
      );
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('should let an explicit BROWSER override headless Linux detection', async () => {
      setPlatform('linux');
      vi.stubEnv('DISPLAY', '');
      vi.stubEnv('WAYLAND_DISPLAY', '');
      vi.stubEnv('MIR_SOCKET', '');
      vi.stubEnv('BROWSER', 'firefox');

      await openReport();

      expect(mockSpawn).toHaveBeenCalledWith(
        'firefox',
        [REPORT_URL],
        expect.any(Object),
      );
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('should fall back to the platform opener for blocklisted BROWSER values', async () => {
      setPlatform('linux');
      vi.stubEnv('DISPLAY', ':1');
      vi.stubEnv('BROWSER', 'www-browser --headless');

      await openReport();

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(mockExecFile).toHaveBeenCalledWith(
        'xdg-open',
        [REPORT_URL],
        expect.any(Object),
      );
    });

    it('should block BROWSER values by command basename before using the platform opener', async () => {
      setPlatform('linux');
      vi.stubEnv('DISPLAY', ':1');
      vi.stubEnv('BROWSER', '/usr/bin/www-browser --headless');

      await openReport();

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(mockExecFile).toHaveBeenCalledWith(
        'xdg-open',
        [REPORT_URL],
        expect.any(Object),
      );
    });

    it('should still skip blocklisted BROWSER values in headless Linux', async () => {
      setPlatform('linux');
      vi.stubEnv('DISPLAY', '');
      vi.stubEnv('WAYLAND_DISPLAY', '');
      vi.stubEnv('MIR_SOCKET', '');
      vi.stubEnv('BROWSER', 'www-browser');
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await openReport();

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(mockExecFile).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Please open this URL manually'),
      );

      consoleSpy.mockRestore();
    });

    it('should ignore BROWSER on Windows and keep the PowerShell opener', async () => {
      setPlatform('win32');
      vi.stubEnv('BROWSER', 'firefox --new-tab');

      await openReport();

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(mockExecFile).toHaveBeenCalledWith(
        'powershell.exe',
        expect.arrayContaining(['-Command', `Start-Process '${REPORT_URL}'`]),
        expect.any(Object),
      );
    });

    it('should ignore blocklisted BROWSER values on Windows', async () => {
      setPlatform('win32');
      vi.stubEnv('BROWSER', 'www-browser');

      await openReport();

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(mockExecFile).toHaveBeenCalledWith(
        'powershell.exe',
        expect.arrayContaining(['-Command', `Start-Process '${REPORT_URL}'`]),
        expect.any(Object),
      );
    });

    it('should fall back to the platform opener for invalid BROWSER values', async () => {
      setPlatform('darwin');
      vi.stubEnv('BROWSER', '"');
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await openReport();

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(mockExecFile).toHaveBeenCalledWith(
        'open',
        [REPORT_URL],
        expect.any(Object),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid BROWSER environment variable'),
      );

      consoleSpy.mockRestore();
    });

    it('should fall back to the platform opener when explicit BROWSER launch fails', async () => {
      setPlatform('linux');
      vi.stubEnv('DISPLAY', ':1');
      vi.stubEnv('BROWSER', 'firefox --new-tab');
      mockExecFile.mockResolvedValueOnce({ stdout: '', stderr: '' });
      mockSpawn.mockImplementationOnce(() => {
        const child: {
          once: ReturnType<typeof vi.fn>;
          unref: ReturnType<typeof vi.fn>;
        } = {
          once: vi.fn((event: string, callback: (error?: Error) => void) => {
            if (event === 'error') {
              callback(new Error('spawn failed'));
            }
            return child;
          }),
          unref: vi.fn(),
        };
        return child;
      });
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(openReport()).resolves.toBeUndefined();

      expect(mockSpawn).toHaveBeenCalledWith(
        'firefox',
        ['--new-tab', REPORT_URL],
        expect.any(Object),
      );
      expect(mockExecFile).toHaveBeenCalledWith(
        'xdg-open',
        [REPORT_URL],
        expect.any(Object),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to open BROWSER command firefox'),
      );

      consoleSpy.mockRestore();
    });

    it('should skip browser launch in headless Linux', async () => {
      setPlatform('linux');
      vi.stubEnv('DISPLAY', '');
      vi.stubEnv('WAYLAND_DISPLAY', '');
      vi.stubEnv('MIR_SOCKET', '');
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await openReport();

      expect(mockExecFile).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Please open this URL manually'),
      );

      consoleSpy.mockRestore();
    });
  });

  describe('Error handling', () => {
    it('should handle browser launch failures gracefully by logging instead of throwing', async () => {
      setPlatform('darwin');
      mockExecFile.mockRejectedValueOnce(new Error('Command not found'));

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(openReport()).resolves.toBeUndefined();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to open browser automatically'),
      );

      consoleSpy.mockRestore();
    });
  });

  describe('Linux Fallback', () => {
    it('should try fallback browsers on Linux', async () => {
      setPlatform('linux');
      vi.stubEnv('DISPLAY', ':1');

      mockExecFile.mockRejectedValueOnce(new Error('Command not found'));
      mockExecFile.mockResolvedValueOnce({ stdout: '', stderr: '' });

      await openReport();

      expect(mockExecFile).toHaveBeenCalledTimes(2);
      expect(mockExecFile).toHaveBeenNthCalledWith(
        1,
        'xdg-open',
        [REPORT_URL],
        expect.any(Object),
      );
      expect(mockExecFile).toHaveBeenNthCalledWith(
        2,
        'gnome-open',
        [REPORT_URL],
        expect.any(Object),
      );
    });

    it('should detach real browser fallback commands', async () => {
      setPlatform('linux');
      vi.stubEnv('DISPLAY', ':1');

      mockExecFile
        .mockRejectedValueOnce(new Error('xdg-open missing'))
        .mockRejectedValueOnce(new Error('gnome-open missing'))
        .mockRejectedValueOnce(new Error('kde-open missing'));

      await openReport();

      expect(mockSpawn).toHaveBeenCalledWith(
        'firefox',
        [REPORT_URL],
        expect.any(Object),
      );
    });
  });
});
