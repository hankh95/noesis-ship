Feature: Channel Messaging
  Agents and humans communicate through channels using the wire protocol.
  The shared wire protocol provides builders for messages, kanban events,
  and fleet alerts.

  Scenario: Build a channel message
    When a message is built from "M5" in group "fleet" saying "all GPUs nominal"
    Then the message type should be "message"
    And the message group should be "fleet"
    And the message from should be "M5"
    And the message should have a timestamp

  Scenario: Build a directed message
    When a message is built from "M5" in group "fleet" saying "check status" directed to "Mini"
    Then the message should have to field "Mini"

  Scenario: Detect self messages
    Given a message from "M5" with fromId "agent:m5"
    When checking if it is from "M5"
    Then it should be detected as self

  Scenario: Detect human messages
    Given a message from "User" with fromId "carclaw:user"
    Then it should be detected as human
    And it should not be detected as agent

  Scenario: Detect agent messages
    Given a message from "M5" with fromId "agent:m5"
    Then it should be detected as agent
    And it should not be detected as human

  Scenario: Channel subject construction
    When building a channel subject for "fleet"
    Then the subject should be "ship.channel.fleet"
