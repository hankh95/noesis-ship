@integration
Feature: Relay Forwarding
  The relay server subscribes to NATS subjects and forwards messages
  to connected WebSocket clients. This enables the Command Deck to
  receive real-time updates without connecting directly to NATS.

  Scenario: Fleet alert reaches WebSocket client
    Given a running NATS server and relay
    And a WebSocket client connected to the relay
    When a fleet alert is published to NATS with alertType "pr_created" and pr 999
    Then the WebSocket client should receive a message with type "fleet_alert"
    And the received message should have alertType "pr_created"

  Scenario: Channel message reaches WebSocket client
    Given a running NATS server and relay
    And a WebSocket client connected to the relay
    When a channel message is published to NATS on "ship.channel.fleet" saying "e2e test"
    Then the WebSocket client should receive a message with type "message"
    And the received message should have message "e2e test"

  Scenario: Kanban event reaches WebSocket client
    Given a running NATS server and relay
    And a WebSocket client connected to the relay
    When a kanban event is published to NATS for item "EXP-777"
    Then the WebSocket client should receive a message with type "kanban_event"
    And the received message should have item id "EXP-777"
