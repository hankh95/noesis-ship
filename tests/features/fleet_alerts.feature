Feature: Fleet Alerts
  Fleet events are published to ship.fleet.alert so the Command Deck
  can display real-time notifications to the captain.

  Scenario: PR created alert has correct payload
    When an agent publishes a pr_created alert for PR 175 by "Mini" on "EXP-994"
    Then the alert type should be "pr_created"
    And the payload should contain pr 175
    And the payload should contain agent "Mini"
    And the payload should contain exp "EXP-994"

  Scenario: CI failed alert includes optional details
    When an agent publishes a ci_failed alert for PR 176 on "EXP-995" with details "lint error"
    Then the alert type should be "ci_failed"
    And the payload should contain pr 176
    And the payload should contain details "lint error"

  Scenario: Agent stuck alert has idle time
    When an agent publishes an agent_stuck alert for "DGX" on "EXP-994" session "exp-994" idle 18 minutes
    Then the alert type should be "agent_stuck"
    And the payload should contain agent "DGX"
    And the payload should contain idle_minutes 18

  Scenario: ACF regression with negative delta
    When an agent publishes an acf_regression alert with delta -0.02 for PR 176 on "EXP-995" being "santiago-toddler-v12"
    Then the alert type should be "acf_regression"
    And the payload should contain delta -0.02

  Scenario: ACF regression guard redirects positive delta to acf_delta
    When an agent publishes an acf_regression alert with delta 0.03 for PR 175 on "EXP-994" being "santiago-toddler-v12"
    Then it should be redirected to acf_delta
    And the payload should contain delta 0.03
