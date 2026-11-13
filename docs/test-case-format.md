# Test case format

## Minimal example

```
TC-001 — Test case title
URL: https://example.com/

Steps:
1. Describe the action.
   Expected: what should happen.
2. Next action.
   Expected: expected result.
```

## Required fields

| Field | Format | Example |
|---|---|---|
| **URL** | `URL:` | `URL: https://app.example.com/login` |
| **Steps** | Numbered list | `1. Click the Login button.` |
| **Expected result** | Line below the step | `   Expected: home page opened.` |

## Credentials and test data

Include credentials directly in the text — the agent will use them automatically:

```
Credentials: user@example.com / P@ssword123
```

or as a precondition:

```
Precondition: log in as admin / secret123
```

The agent will only ask you interactively for OTP codes and SMS codes.

## Multiple test cases in one run

List them one after another — each with its own title:

```
TC-001 — Login check
URL: https://app.example.com/

Steps:
1. Open the page.
   Expected: login form is displayed.
2. Enter valid credentials and click Login.
   Expected: user lands on the dashboard.

TC-002 — Wrong password error
URL: https://app.example.com/

Steps:
1. Enter correct username and wrong password, click Login.
   Expected: error message appears.
```

The agent runs them in order and reports results for each separately.

## Tips

- **One step = one action + one expected result.** Don't combine multiple checks.
- **Be specific about expected results:** `"counter shows 1"` is better than `"cart updated"`.
- **URL** should be where the test starts.
- Preconditions (login, navigation) can be listed separately — the agent handles them silently without including them in the step report.

## Full example

```
TC-001 — Login and add item to cart
URL: https://www.saucedemo.com/
Credentials: standard_user / secret_sauce

Steps:
1. Open the home page.
   Expected: login form with Username and Password fields is visible.
2. Enter Username "standard_user" and Password "secret_sauce", click Login.
   Expected: Products page opens with 6 items.
3. Click "Add to cart" on "Sauce Labs Backpack".
   Expected: cart counter shows 1.
4. Click the cart icon.
   Expected: cart contains exactly one item — Sauce Labs Backpack at $29.99.
```
