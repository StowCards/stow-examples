<?php

/**
 * The loyalty loop end to end: list programs, enrol a member, award points,
 * read the member back.
 *
 *   STOW_API_KEY=stow_... php demo.php
 */

declare(strict_types=1);

/** Print one line to stderr, after everything already printed to stdout, and exit. */
function fail(string $message, int $exitCode = 1): never
{
    while (ob_get_level() > 0) {
        ob_end_flush();
    }
    flush();
    // Invalid UTF-8 becomes U+FFFD, then every run of Unicode spaces and line breaks
    // (U+0085, U+2028 and U+2029 among them) one space.
    $message = json_decode(json_encode($message, JSON_INVALID_UTF8_SUBSTITUTE));
    fwrite(STDERR, trim(preg_replace('/[\x{9}-\x{D}\x{1C}-\x{20}\x{85}\x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]+/u', ' ', $message) ?? '', ' ') . PHP_EOL);
    exit($exitCode);
}

if (PHP_VERSION_ID < 80200 || !extension_loaded('curl')) {
    fail('Configuration error: this example needs PHP 8.2 or later with ext-curl (found PHP ' . PHP_VERSION . ').', 2);
}

require __DIR__ . '/StowClient.php';

try {
    $stow = StowClient::fromEnvironment(
        onRetry: static function (string $notice): void {
            echo "   {$notice}\n";
        },
    );
} catch (InvalidArgumentException $e) {
    fail('Configuration error: ' . $e->getMessage(), 2);
}

try {
    echo "1. Listing programs\n";
    $program = null;
    foreach ($stow->listPrograms() as $candidate) {
        if (($candidate['status'] ?? null) === 'active') {
            $program = $candidate;
            break;
        }
        printf("   skipping \"%s\" (%s)\n", $candidate['name'] ?? $candidate['_id'], $candidate['status'] ?? 'no status');
    }
    if ($program === null) {
        fail('Error: No active program found. Publish a program in the web console (Pass Designer) first.');
    }
    // Programs are keyed by `_id`; members by `id`.
    printf("   using \"%s\" (%s)\n", $program['name'] ?? '', $program['_id']);

    echo "2. Enrolling a member\n";
    $email = sprintf('dev+%d@example.com', (int) floor(microtime(true) * 1000));
    $member = $stow->enrollMember([
        'programId' => $program['_id'],
        'firstName' => 'Ada',
        'lastName' => 'Lovelace',
        'email' => $email,
        'initialPoints' => 50,
    ]);
    printf("   enrolled %s\n", $email);
    if (($member['deduped'] ?? false) === true) {
        echo "   deduped: true, an existing member with this email was returned\n";
    }
    foreach (['apple' => 'Apple Wallet', 'google' => 'Google Wallet'] as $wallet => $label) {
        if (($member['passIssuance'][$wallet] ?? true) === false) {
            echo "   note: the {$label} pass could not be issued\n";
        }
    }

    echo "3. Awarding 10 points\n";
    // One key for this gesture. The client resends the same key on every
    // retry, so the points are added once however many attempts it takes.
    $idempotencyKey = StowClient::uuidV4();
    $result = $stow->adjustPoints(
        $member['id'],
        ['delta' => 10, 'changeMessage' => 'Thanks for visiting!'],
        $idempotencyKey,
    );
    printf("   balance %s -> %s\n", $result['previous'] ?? '?', $result['current'] ?? '?');

    echo "4. Reading the member back\n";
    $detail = $stow->getMember($member['id']);
    // The balance lives under the member's program balanceKey, else the listed
    // program's, else "points". Only that key is read, never another one.
    $balanceKey = 'points';
    foreach ([$detail['program']['balanceKey'] ?? null, $program['balanceKey'] ?? null] as $candidateKey) {
        if (is_string($candidateKey) && $candidateKey !== '') {
            $balanceKey = $candidateKey;
            break;
        }
    }
    $fieldValues = is_array($detail['fieldValues'] ?? null) ? $detail['fieldValues'] : [];
    $balance = $fieldValues[$balanceKey] ?? null;
    $appleMode = $detail['apple']['mode'] ?? 'unknown';
    $googleMode = $detail['google']['mode'] ?? 'unknown';

    // memberCode is the only identifier to show people; never id or serialNumber.
    printf("   Member ID:     %s\n", $detail['memberCode'] ?? '(none, enrolled before Member IDs existed)');
    printf("   Balance:       %s %s\n", is_int($balance) || is_float($balance) || is_string($balance) ? $balance : 'n/a', $balanceKey);
    printf("   Apple Wallet:  %s (mode: %s)\n", $detail['apple']['passUrl'] ?? '(not issued)', $appleMode);
    printf("   Google Wallet: %s (mode: %s)\n", $detail['google']['saveUrl'] ?? '(not issued)', $googleMode);
    if ($appleMode === 'stub' || $googleMode === 'stub') {
        echo "   Stub mode: wallet credentials are not configured, so no pass update reaches a device.\n";
    }
} catch (StowException $e) {
    fail('Error: ' . $e->summary());
} catch (Throwable $e) {
    fail('Error: ' . $e->getMessage());
}
