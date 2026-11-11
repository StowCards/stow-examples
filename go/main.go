// Command quickstart runs the Stow Cards loyalty loop against the public REST
// API: list programs, enrol a member, award points and read the member back.
//
//	export STOW_API_KEY=stow_...
//	go run .
//
// It exits with 2 for a configuration error, 1 for an API or connection error
// and 130 when interrupted with Ctrl+C.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"slices"
	"strconv"
	"strings"
	"time"

	"stowcards.example/quickstart/stow"
)

func main() {
	client, err := stow.NewClientFromEnv()
	if err != nil {
		fmt.Fprintln(os.Stderr, "Configuration error:", err)
		os.Exit(2)
	}
	client.OnRetry = func(method, path string, retry int, wait time.Duration, cause error) {
		fmt.Printf("  retry %d of %d for %s %s in %s after: %s\n",
			retry, stow.MaxRetries, method, path, wait.Round(time.Millisecond), oneLine(cause.Error()))
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	err = run(ctx, client)
	stop()
	if errors.Is(err, context.Canceled) {
		fmt.Fprintln(os.Stderr, "Interrupted.")
		os.Exit(130)
	}
	if err != nil {
		// Progress went to os.Stdout, which is unbuffered, so it is all written.
		fmt.Fprintln(os.Stderr, "Error:", oneLine(err.Error()))
		os.Exit(1)
	}
}

func run(ctx context.Context, client *stow.Client) error {
	// 1. Pick a program whose balance the points call can change.
	programs, err := client.ListPrograms(ctx)
	if err != nil {
		return err
	}
	program := pickProgram(programs)
	if program == nil {
		return fmt.Errorf("none of the %d programs on this merchant is an active points, tiered, gift card or stamp card program: publish one in the web console (Pass Designer) first", len(programs))
	}
	stamps := program.ProgramType == "stamps"
	fmt.Printf("Program:       %s (%s, %s) of %d\n", program.Name, program.ID, program.ProgramType, len(programs))

	// 2. Enrol a new member. A stamp card starts empty: a starting balance of
	// 50 would fill it (InitialPoints 0 is left out of the request).
	initialPoints := 50
	if stamps {
		initialPoints = 0
	}
	email := fmt.Sprintf("dev+%d@example.com", time.Now().UnixMilli())
	enrolled, err := client.EnrollMember(ctx, stow.EnrollRequest{
		ProgramID:     program.ID,
		FirstName:     "Ada",
		LastName:      "Lovelace",
		Email:         email,
		InitialPoints: initialPoints,
	})
	if err != nil {
		return err
	}
	fmt.Printf("Enrolled:      %s\n", email)
	if enrolled.Deduped {
		fmt.Println("               deduped: true (this email was already enrolled, so the existing member came back)")
	}
	if pi := enrolled.PassIssuance; pi != nil && (!pi.Apple || !pi.Google) {
		fmt.Printf("               passIssuance: apple=%t google=%t (a wallet link that is false was not issued)\n", pi.Apple, pi.Google)
	}

	// 3. Award 10 points, or one stamp on a stamp card (which moves one stamp
	// at a time), under one Idempotency-Key for this gesture.
	key, err := stow.NewIdempotencyKey()
	if err != nil {
		return fmt.Errorf("make an idempotency key: %w", err)
	}
	delta := 10
	if stamps {
		delta = 1
	}
	change := stow.PointsChange{Delta: delta, ChangeMessage: "Thanks for visiting!"}
	adjusted, err := client.AdjustPoints(ctx, enrolled.ID, change, key)
	if err != nil {
		return err
	}
	fmt.Printf("Points:        %d -> %d (Idempotency-Key %s)\n", adjusted.Previous, adjusted.Current, key)

	// 4. Read the member back.
	member, err := client.GetMember(ctx, enrolled.ID)
	if err != nil {
		return err
	}
	fmt.Printf("Member ID:     %s\n", orNone(member.MemberCode))
	fmt.Printf("Balance:       %s\n", balance(member, program))
	fmt.Printf("Apple Wallet:  %s (mode: %s)\n", orNone(member.Apple.PassURL), orNone(member.Apple.Mode))
	fmt.Printf("Google Wallet: %s (mode: %s)\n", orNone(member.Google.SaveURL), orNone(member.Google.Mode))
	if member.Apple.Mode == "stub" || member.Google.Mode == "stub" {
		fmt.Println("Stub mode: wallet credentials are missing on this server, so pass updates reach no phone.")
	}
	return nil
}

// pickProgram returns the first active program with a points balance (points,
// tiered or gift card), else the first active stamp card, else nil. Other pass
// types (coupons, memberships, tickets...) have no balance to change.
func pickProgram(programs []stow.Program) *stow.Program {
	for _, wanted := range [][]string{{"points", "tiered", "giftCard"}, {"stamps"}} {
		for i := range programs {
			if programs[i].Status == "active" && slices.Contains(wanted, programs[i].ProgramType) {
				return &programs[i]
			}
		}
	}
	return nil
}

// balance prints fieldValues under one key: the member's program.balanceKey,
// else the listed program's balanceKey, else "points". It prints "n/a" when
// that entry is missing, never another key's value.
func balance(member *stow.MemberDetail, listed *stow.Program) string {
	key := "points"
	if member.Program != nil && member.Program.BalanceKey != "" {
		key = member.Program.BalanceKey
	} else if listed.BalanceKey != "" {
		key = listed.BalanceKey
	}
	value := "n/a"
	if n, ok := member.Balance(key); ok {
		value = strconv.FormatInt(n, 10)
	} else if raw, ok := member.FieldValues[key]; ok && string(raw) != "null" {
		value = string(raw)
	}
	return value + " (fieldValues." + key + ")"
}

func orNone(s string) string {
	if s == "" {
		return "(none)"
	}
	return s
}

func oneLine(s string) string {
	return strings.Join(strings.Fields(s), " ")
}
