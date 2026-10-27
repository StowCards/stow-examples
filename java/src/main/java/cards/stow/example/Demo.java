package cards.stow.example;

import java.io.IOException;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * The loyalty loop end to end: pick an active program, enrol a member, award 10 points,
 * then read the member back.
 */
public final class Demo {

    // Every Unicode space and line break (U+0085, U+2028 and U+2029 included), other control characters and BOM.
    private static final Pattern NOT_ONE_LINE = Pattern.compile("[\\p{Z}\\p{Cc}\\uFEFF]+");

    private Demo() {
    }

    /** Exits 0 on success, 1 on an API or connection error, 2 on a configuration error. */
    public static void main(String[] args) {
        StowClient stow;
        try {
            stow = StowClient.fromEnvironment();
        } catch (IllegalStateException e) {
            fail(2, "Configuration error: " + e.getMessage());
            return;
        }
        stow.onRetry(note -> System.out.println("[stow] " + note)); // retries are progress, so standard output
        try {
            run(stow);
        } catch (StowApiException e) {
            fail(1, "Error: " + e.getMessage());
        } catch (IOException e) {
            fail(1, "Error: " + e.getMessage());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            fail(1, "Error: INTERRUPTED: the run was interrupted.");
        }
    }

    private static void run(StowClient stow) throws IOException, InterruptedException {
        System.out.println("API:       " + stow.baseUrl());

        // 1. The first active program.
        StowClient.Program program = null;
        for (StowClient.Program candidate : stow.listPrograms()) {
            if ("active".equals(candidate.status())) {
                program = candidate;
                break;
            }
            System.out.printf("Skipped:   %s (status %s)%n", candidate.name(), candidate.status());
        }
        if (program == null) {
            fail(1, "Error: No active program found. Publish a program in the Stow Cards console "
                    + "(Pass Designer) first.");
            return;
        }
        System.out.printf("Program:   %s (%s)%n", program.name(), program.id());

        // 2. Enrol a member.
        String email = "dev+" + System.currentTimeMillis() + "@example.com";
        StowClient.Member enrolled = stow.enrollMember(
                new StowClient.EnrollRequest(program.id(), "Ada", "Lovelace", email, 50));
        System.out.printf("Enrolled:  %s %s <%s>%n", enrolled.firstName(), enrolled.lastName(), enrolled.email());
        if (enrolled.deduped()) {
            System.out.println("           deduped: true, so this email was already enrolled and nothing was created");
        }

        // 3. Award 10 points. One Idempotency-Key for this gesture, reused on every retry of it.
        String idempotencyKey = UUID.randomUUID().toString();
        StowClient.PointsResult result = stow.adjustPoints(enrolled.id(), 10, "Thanks for visiting!", idempotencyKey);
        System.out.printf("Awarded:   10 points (%s -> %s)%n", result.previous(), result.current());

        // 4. Read the member back.
        StowClient.Member member = stow.getMember(enrolled.id());
        StowClient.AppleWallet apple = member.apple();
        StowClient.GoogleWallet google = member.google();
        String appleMode = apple == null ? null : apple.mode();
        String googleMode = google == null ? null : google.mode();
        System.out.println();
        System.out.println("Member ID: " + orNone(member.memberCode()));
        System.out.println("Balance:   " + balance(member, program));
        System.out.printf("Apple:     %s (mode: %s)%n", orNone(apple == null ? null : apple.passUrl()), orNone(appleMode));
        System.out.printf("Google:    %s (mode: %s)%n", orNone(google == null ? null : google.saveUrl()), orNone(googleMode));
        if ("stub".equals(appleMode) || "stub".equals(googleMode)) {
            System.out.println("Stub mode: wallet credentials are not configured, so no update reaches a device.");
        }
    }

    /**
     * The balance sits in fieldValues under the member's program balanceKey, else the balanceKey of
     * the program picked in step 1, else "points". A key that is missing, not a string or empty is
     * skipped; one of only spaces is used as it is. Only that key is read.
     */
    private static String balance(StowClient.Member member, StowClient.Program program) {
        Map<String, Object> values = member.fieldValues() == null ? Map.of() : member.fieldValues();
        String key = firstNonEmpty(member.program() == null ? null : member.program().balanceKey(),
                program.balanceKey(), "points");
        Object value = values.get(key);
        return (value == null ? "n/a" : String.valueOf(value)) + " (fieldValues." + key + ")";
    }

    private static String firstNonEmpty(String... values) {
        for (String value : values) {
            if (value != null && !value.isEmpty()) {
                return value;
            }
        }
        return null;
    }

    private static String orNone(String value) {
        return value == null || value.isBlank() ? "(none)" : value;
    }

    /** One line on standard error, after everything already on standard output. */
    private static void fail(int exitCode, String message) {
        System.out.flush();
        System.err.println(NOT_ONE_LINE.matcher(message).replaceAll(" ").strip());
        System.exit(exitCode);
    }
}
