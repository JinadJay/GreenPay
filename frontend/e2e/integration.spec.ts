import { test, expect, type Page } from "@playwright/test";

const SEEDED_PROJECT_ID = "8d9ac19b-52eb-42f7-80d9-19a88ba59e43";
const OWNER_WALLET = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const DONOR_WALLET = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGLEWZE5BGYTG2XTGQBC3VP";
const DUMMY_TX_HASH = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

// Mock Freighter
async function mockFreighter(page: Page, publicKey: string) {
  await page.addInitScript((pk) => {
    (window as unknown as Record<string, unknown>).__test_publicKey__ = pk;
    (window as unknown as Record<string, unknown>).freighter = {
      isConnected: () => Promise.resolve({ isConnected: true }),
    };
  }, publicKey);
}

// Mock Horizon/Stellar (since we don't hit the real network in E2E tests)
async function mockHorizon(page: Page) {
  await page.route("**/horizon-testnet.stellar.org/**", (route) => {
    const url = route.request().url();
    if (url.includes("/accounts/")) {
      return route.fulfill({ json: { account_id: DONOR_WALLET, sequence: "100" } });
    }
    if (url.includes("/transactions")) {
      return route.fulfill({
        json: {
          successful: true,
          hash: DUMMY_TX_HASH,
        },
      });
    }
    return route.fulfill({
      json: {
        _embedded: { records: [] },
        balances: [{ asset_type: "native", balance: "500.0000000" }],
      },
    });
  });

  await page.route("**/soroban-testnet.stellar.org/**", (route) => {
    const body = route.request().postDataJSON() as { id: unknown; method?: string };
    if (body?.method === "simulateTransaction") {
      return route.fulfill({
        json: {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            id: "1",
            latestLedger: 1000,
            transactionData: "AAAAAgAAAAAAAAAAAAAAAd4m2h8=",
            minResourceFee: "100000",
            cost: { cpuInsns: "0", memBytes: "0" },
            results: [{ xdr: "AAAAAQAAAAEAAAAAAAAAAQ==" }],
            events: [],
          },
        },
      });
    }
    return route.fulfill({ json: { jsonrpc: "2.0", id: body?.id, result: {} } });
  });
}

test.describe("E2E Integration Tests (No API Mocking)", () => {
  test.beforeEach(async ({ page }) => {
    page.on("console", (msg) => {
      console.log(`[BROWSER CONSOLE] [${msg.type()}] ${msg.text()}`);
    });
    page.on("pageerror", (err) => {
      console.log(`[BROWSER PAGE ERROR] ${err.message}`);
    });
    page.on("requestfailed", (req) => {
      console.log(`[BROWSER REQUEST FAILED] ${req.url()} - ${req.failure()?.errorText || "unknown"}`);
    });
  });

  test("1. Project Browsing Flow", async ({ page }) => {
    // Go to home page
    await page.goto("/");
    await expect(page.getByText("Fund the planet.").first()).toBeVisible();

    // Go to project listing
    await page.goto("/projects");
    await expect(page.getByText("Amazon Reforestation Initiative")).toBeVisible();

    // Navigate to details page
    await page.getByText("Amazon Reforestation Initiative").click();
    await expect(page).toHaveURL(new RegExp(`/projects/${SEEDED_PROJECT_ID}`));
    await expect(page.getByText("Amazon Reforestation Initiative").first()).toBeVisible();
  });

  test("2. Core Donation Flow", async ({ page }) => {
    // Navigate to donate page directly with a preset amount
    await page.goto(`/donate/${SEEDED_PROJECT_ID}?amount=25`);

    // Verify project name displays correctly (indicates that getServerSideProps unwrapped the envelope)
    // If the bug were present, it would display "Untitled Project"
    await expect(page.getByText("Amazon Reforestation Initiative").first()).toBeVisible();
    await expect(page.getByText("Untitled Project")).not.toBeVisible();
    await expect(page).toHaveTitle(/Donate to Amazon Reforestation Initiative/i);

    // The current donation experience is QR/URI based rather than an inline submit form.
    const donateCard = page.locator(".donate-card");
    await expect(donateCard).toBeVisible();
    await expect(donateCard.getByText("Preset donation:")).toContainText("25 XLM");
    await expect(donateCard.getByText(/Scan to donate with Freighter/i)).toBeVisible();
    await expect(donateCard.getByLabel("Copy Stellar URI")).toBeVisible();
    await expect(donateCard.getByRole("button", { name: /Download QR/i })).toBeVisible();
    await expect(donateCard.getByRole("button", { name: /Print/i })).toBeVisible();

    // Verify the generated Stellar URI is rendered with the seeded wallet and preset amount.
    await expect(donateCard.getByText(/web\+stellar:pay\?/)).toContainText("amount=25");
  });

  test("3. Admin Status Flow", async ({ page }) => {
    // Connect wallet as project owner (admin)
    await mockFreighter(page, OWNER_WALLET);
    await page.goto(`/admin/${SEEDED_PROJECT_ID}`);

    // Verify page title and active status
    await expect(page.getByText("Project Admin")).toBeVisible();
    const approvalWorkflowCard = page.locator(".card", { hasText: /Approval Workflow/i });
    const currentStatus = approvalWorkflowCard.locator("p", { hasText: /Current status:/ });
    await expect(currentStatus).toContainText("Current status: active");

    // Reject the project
    await page.getByPlaceholder("Provide a reason for this decision...").fill("Testing reject integration flow");
    const rejectBtn = page.getByRole("button", { name: "Reject" });
    await expect(rejectBtn).toBeEnabled();
    await rejectBtn.click();

    // Verify status changed to rejected
    await expect(currentStatus).toContainText("Current status: rejected");
    await expect(page.getByText("Testing reject integration flow")).toBeVisible();

    // Approve it back to active
    const approveBtn = page.getByRole("button", { name: "Approve" });
    await expect(approveBtn).toBeEnabled();
    await approveBtn.click();

    // Verify status is back to active
    await expect(currentStatus).toContainText("Current status: active");
  });
});
