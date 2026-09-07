// Copyright 2024 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const {
  createIntegrationContext,
  delay,
  getUsableDiscovery,
  platformTimeout,
  processExists,
  reconnectDaemonClient,
  waitFor,
} = require("./helpers/integration_harness");

const DISCONNECT_CALLBACK_LATENCY_BUDGET_MS = platformTimeout(1000);
const RECONNECT_CALLBACK_LATENCY_BUDGET_MS = platformTimeout(3000);
const STRESS_CONNECTOR_COUNT = 20;
const STRESS_CLOSES_PER_CONNECTOR_PER_DIRECTION = 5;

describe("multiplexer integration control net reliability", function () {
  this.timeout(platformTimeout(30000));

  let context;

  afterEach(async function () {
    if (context) {
      await context.cleanup();
      context = undefined;
    }
  });

  it("propagates one Connector-initiated reconnect to both endpoint callbacks without disturbing peers", async function () {
    const setup = await createConnectedScenario(
      "control-ws-single-reconnect",
      3
    );
    const { connectors, observations, tracePath } = setup;
    const initialInfo = getUsableDiscovery(context.discovery);
    const stateOffsets = observations.map(({ states }) => states.length);
    const traceOffset = readTrace(tracePath).length;
    const daemonLogOffset = context.readLog().length;
    const startedAt = Date.now();
    const startedAtNs = monotonicNowNs();

    // The public Connector facade intentionally hides its control client. This
    // integration test reaches through that boundary only to initiate the
    // exact Connector-side net.Socket reconnect whose callbacks are under test.
    await reconnectDaemonClient(connectors[0].daemonClient);

    await waitFor(
      () =>
        observations[0].states.length >= stateOffsets[0] + 2 &&
        readControlTrace(tracePath, traceOffset).filter(
          (node) => node.event === "control_socket_disconnected"
        ).length >= 1 &&
        readControlTrace(tracePath, traceOffset).filter(
          (node) => node.event === "control_socket_connected"
        ).length >= 1,
      4000
    );
    await waitFor(
      () =>
        connectors[0].devices.has("device-1") &&
        connectors.every(
          (connector) => connector.daemonClient.status === "connected"
        ),
      4000
    );

    const firstCycle = observations[0].states.slice(stateOffsets[0]);
    assert.deepStrictEqual(
      firstCycle.map(({ state }) => state),
      ["disconnected", "connected"],
      "the reconnecting Connector should invoke each connection callback once"
    );
    assertLatencyWithinBudget(
      "Connector disconnected callback",
      startedAt,
      firstCycle[0].at,
      DISCONNECT_CALLBACK_LATENCY_BUDGET_MS
    );
    assertLatencyWithinBudget(
      "Connector reconnected callback",
      startedAt,
      firstCycle[1].at,
      RECONNECT_CALLBACK_LATENCY_BUDGET_MS
    );

    const daemonCycle = readControlTrace(tracePath, traceOffset);
    const daemonDisconnected = daemonCycle.find(
      (node) => node.event === "control_socket_disconnected"
    );
    const daemonReconnected = daemonCycle.find(
      (node) => node.event === "control_socket_connected"
    );
    assert(daemonDisconnected, "Daemon disconnect callback should be traced");
    assert(daemonReconnected, "Daemon reconnect callback should be traced");
    assert.strictEqual(
      daemonDisconnected.metadata.activeControlCount,
      2,
      "Daemon should keep the two peer controls active"
    );
    assert.strictEqual(
      daemonReconnected.metadata.activeControlCount,
      3,
      "Daemon should restore the reconnected control"
    );
    assertTraceLatencyWithinBudget(
      "Daemon disconnected callback",
      startedAt,
      daemonDisconnected,
      DISCONNECT_CALLBACK_LATENCY_BUDGET_MS
    );
    assertTraceLatencyWithinBudget(
      "Daemon reconnected callback",
      startedAt,
      daemonReconnected,
      RECONNECT_CALLBACK_LATENCY_BUDGET_MS
    );

    for (let index = 1; index < connectors.length; index++) {
      assert.strictEqual(
        observations[index].states.length,
        stateOffsets[index],
        `peer Connector ${index} should not receive a false connection callback`
      );
    }
    assert.strictEqual(
      getUsableDiscovery(context.discovery).pid,
      initialInfo.pid,
      "one Connector reconnect should not replace the shared Daemon"
    );
    await assertEveryConnectorUsable(connectors);

    const daemonCallbacks = await waitFor(() => {
      const callbacks = readDaemonControlCallbacks(context, daemonLogOffset);
      return (
        callbacks.some(
          (entry) => entry.event === "control-disconnected-callback"
        ) &&
        callbacks.some(
          (entry) => entry.event === "control-connected-callback"
        ) &&
        callbacks
      );
    }, 2000);
    const daemonDisconnectedCallback = daemonCallbacks.find(
      (entry) => entry.event === "control-disconnected-callback"
    );
    const daemonConnectedCallback = daemonCallbacks.find(
      (entry) => entry.event === "control-connected-callback"
    );
    logReliabilityResult({
      scenario: "single_connector_initiated_reconnect",
      direction: "connector_to_daemon",
      latencyMs: {
        actionToConnectorDisconnect: elapsedMonotonicMs(
          startedAtNs,
          firstCycle[0].monotonicAtNs
        ),
        connectorDisconnectToDaemonCallback: elapsedMonotonicMs(
          firstCycle[0].monotonicAtNs,
          daemonDisconnectedCallback.monotonicAtNs
        ),
        connectCallbackDeltaConnectorMinusDaemon: elapsedMonotonicMs(
          daemonConnectedCallback.monotonicAtNs,
          firstCycle[1].monotonicAtNs
        ),
        actionToConnectorReconnect: elapsedMonotonicMs(
          startedAtNs,
          firstCycle[1].monotonicAtNs
        ),
      },
      clock: "process.hrtime.bigint",
      signedConnectCallbackDelta:
        "connector callback time minus daemon callback time; negative means connector callback ran first",
      peerFalseCallbackCount: 0,
      daemonReused: true,
    });
  });

  it("keeps every peer usable while multiple Connectors disconnect and automatically reconnect in turn", async function () {
    const setup = await createConnectedScenario(
      "control-ws-rotating-reconnect",
      3
    );
    const { connectors, observations, tracePath } = setup;
    const initialInfo = getUsableDiscovery(context.discovery);
    const roundMetrics = [];

    for (let targetIndex = 0; targetIndex < connectors.length; targetIndex++) {
      const stateOffsets = observations.map(({ states }) => states.length);
      const traceOffset = readTrace(tracePath).length;
      const daemonLogOffset = context.readLog().length;
      const startedAt = Date.now();
      const startedAtNs = monotonicNowNs();

      // Sequential startup assigns control IDs 1..N. Targeting those original
      // IDs makes the round-robin fault injection deterministic even though
      // every recovered Connector receives a new control ID.
      context.appendCommand({
        type: "emit-control-socket-error",
        controlId: targetIndex + 1,
        message: `round-robin disconnect ${targetIndex}`,
      });

      await waitFor(
        () =>
          observations[targetIndex].states.length >=
            stateOffsets[targetIndex] + 2 &&
          connectors[targetIndex].devices.has("device-1"),
        5000
      ).catch((error) => {
        error.message += `; target=${targetIndex}, states=${JSON.stringify(
          observations.map(({ states }) => states.map(({ state }) => state))
        )}, connected=${JSON.stringify(
          connectors.map(
            (connector) => connector.daemonClient.status === "connected"
          )
        )}, controlTrace=${JSON.stringify(
          readControlTrace(tracePath, traceOffset)
        )}`;
        throw error;
      });
      await waitFor(() => {
        const cycle = readControlTrace(tracePath, traceOffset);
        return (
          cycle.filter((node) => node.event === "control_socket_disconnected")
            .length >= 1 &&
          cycle.filter((node) => node.event === "control_socket_connected")
            .length >= 1
        );
      }, 5000);

      const connectorCycle = observations[targetIndex].states.slice(
        stateOffsets[targetIndex]
      );
      assert.deepStrictEqual(
        connectorCycle.map(({ state }) => state),
        ["disconnected", "connected"],
        `Connector ${targetIndex} should invoke one disconnect/reconnect callback pair`
      );
      assertLatencyWithinBudget(
        `Connector ${targetIndex} disconnected callback`,
        startedAt,
        connectorCycle[0].at,
        DISCONNECT_CALLBACK_LATENCY_BUDGET_MS
      );
      assertLatencyWithinBudget(
        `Connector ${targetIndex} reconnected callback`,
        startedAt,
        connectorCycle[1].at,
        RECONNECT_CALLBACK_LATENCY_BUDGET_MS
      );

      const daemonCycle = readControlTrace(tracePath, traceOffset);
      const daemonDisconnected = daemonCycle.find(
        (node) => node.event === "control_socket_disconnected"
      );
      const daemonReconnected = daemonCycle.find(
        (node) => node.event === "control_socket_connected"
      );
      assert.strictEqual(
        daemonDisconnected.metadata.activeControlCount,
        connectors.length - 1
      );
      assert.strictEqual(
        daemonReconnected.metadata.activeControlCount,
        connectors.length
      );
      assertTraceLatencyWithinBudget(
        `Daemon callback for Connector ${targetIndex} disconnect`,
        startedAt,
        daemonDisconnected,
        DISCONNECT_CALLBACK_LATENCY_BUDGET_MS
      );
      assertTraceLatencyWithinBudget(
        `Daemon callback for Connector ${targetIndex} reconnect`,
        startedAt,
        daemonReconnected,
        RECONNECT_CALLBACK_LATENCY_BUDGET_MS
      );

      for (let peerIndex = 0; peerIndex < connectors.length; peerIndex++) {
        if (peerIndex === targetIndex) {
          continue;
        }
        assert.strictEqual(
          observations[peerIndex].states.length,
          stateOffsets[peerIndex],
          `peer Connector ${peerIndex} should stay connected during Connector ${targetIndex} churn`
        );
      }
      await assertEveryConnectorUsable(connectors);

      const daemonCallbacks = await waitFor(() => {
        const callbacks = readDaemonControlCallbacks(context, daemonLogOffset);
        return (
          callbacks.some(
            (entry) => entry.event === "control-disconnected-callback"
          ) &&
          callbacks.some(
            (entry) => entry.event === "control-connected-callback"
          ) &&
          callbacks
        );
      }, 2000);
      const daemonDisconnectedCallback = daemonCallbacks.find(
        (entry) => entry.event === "control-disconnected-callback"
      );
      const daemonConnectedCallback = daemonCallbacks.find(
        (entry) => entry.event === "control-connected-callback"
      );
      roundMetrics.push({
        targetConnector: targetIndex,
        controlId: targetIndex + 1,
        injectedCommandToDaemonDisconnect: elapsedMonotonicMs(
          startedAtNs,
          daemonDisconnectedCallback.monotonicAtNs
        ),
        daemonDisconnectToConnectorCallback: elapsedMonotonicMs(
          daemonDisconnectedCallback.monotonicAtNs,
          connectorCycle[0].monotonicAtNs
        ),
        connectorDisconnectedDuration: elapsedMonotonicMs(
          connectorCycle[0].monotonicAtNs,
          connectorCycle[1].monotonicAtNs
        ),
        connectCallbackDeltaConnectorMinusDaemon: elapsedMonotonicMs(
          daemonConnectedCallback.monotonicAtNs,
          connectorCycle[1].monotonicAtNs
        ),
      });
    }

    assert.strictEqual(
      getUsableDiscovery(context.discovery).pid,
      initialInfo.pid,
      "round-robin Connector reconnects should reuse one Daemon"
    );
    logReliabilityResult({
      scenario: "round_robin_daemon_initiated_disconnect",
      direction: "daemon_to_connector",
      clock: "process.hrtime.bigint",
      rounds: roundMetrics,
      summaryMs: {
        daemonDisconnectToConnectorCallback: summarizeMs(
          roundMetrics.map((round) => round.daemonDisconnectToConnectorCallback)
        ),
        connectorDisconnectedDuration: summarizeMs(
          roundMetrics.map((round) => round.connectorDisconnectedDuration)
        ),
      },
      signedConnectCallbackDelta:
        "connector callback time minus daemon callback time; negative means connector callback ran first",
      peerFalseCallbackCount: 0,
      daemonReused: true,
    });
  });

  it("notifies every Connector and restores all mirrors after a Daemon-side shutdown", async function () {
    const setup = await createConnectedScenario(
      "control-ws-daemon-shutdown",
      3,
      true
    );
    const { connectors, observations, tracePath } = setup;
    const initialInfo = getUsableDiscovery(context.discovery);
    const stateOffsets = observations.map(({ states }) => states.length);
    const deviceDisconnected = connectors.map(() => []);
    const clientDisconnected = connectors.map(() => []);
    connectors.forEach((connector, index) => {
      connector.on("device-disconnected", (device) => {
        deviceDisconnected[index].push({
          serial: device.serial,
          at: Date.now(),
          monotonicAtNs: monotonicNowNs(),
        });
      });
      connector.on("client-disconnected", (id) => {
        clientDisconnected[index].push({
          id,
          at: Date.now(),
          monotonicAtNs: monotonicNowNs(),
        });
      });
    });
    const daemonLogOffset = context.readLog().length;
    const startedAt = Date.now();
    const startedAtNs = monotonicNowNs();

    await stopDaemonFromDaemonSide(initialInfo);

    await waitFor(
      () =>
        observations.every(
          ({ states }, index) =>
            states.length >= stateOffsets[index] + 2 &&
            states[stateOffsets[index]].state === "disconnected" &&
            states[stateOffsets[index] + 1].state === "connected"
        ) &&
        connectors.every(
          (connector) =>
            connector.daemonClient.status === "connected" &&
            connector.devices.has("device-1") &&
            connector.usbClients.has(1)
        ),
      8000
    );
    const nextInfo = await waitFor(() => {
      const info = getUsableDiscovery(context.discovery);
      return info?.pid !== initialInfo.pid ? info : null;
    }, 5000);

    assert.strictEqual(
      processExists(initialInfo.pid),
      false,
      "the stopped Daemon process should be gone"
    );
    assert(
      processExists(nextInfo.pid),
      "the replacement Daemon process should be alive"
    );

    for (let index = 0; index < connectors.length; index++) {
      const cycle = observations[index].states.slice(stateOffsets[index]);
      assert.deepStrictEqual(
        cycle.map(({ state }) => state),
        ["disconnected", "connected"],
        `Connector ${index} should receive one callback pair for Daemon replacement`
      );
      assertLatencyWithinBudget(
        `Connector ${index} Daemon-loss callback`,
        startedAt,
        cycle[0].at,
        DISCONNECT_CALLBACK_LATENCY_BUDGET_MS
      );
      assertLatencyWithinBudget(
        `Connector ${index} recovery callback`,
        startedAt,
        cycle[1].at,
        RECONNECT_CALLBACK_LATENCY_BUDGET_MS
      );
      assert.deepStrictEqual(
        deviceDisconnected[index].map(({ serial }) => serial),
        ["device-1"],
        `Connector ${index} should invoke its device-disconnected callback`
      );
      assert.deepStrictEqual(
        clientDisconnected[index].map(({ id }) => id),
        [1],
        `Connector ${index} should invoke its client-disconnected callback`
      );
      assertLatencyWithinBudget(
        `Connector ${index} device-disconnected callback`,
        startedAt,
        deviceDisconnected[index][0].at,
        DISCONNECT_CALLBACK_LATENCY_BUDGET_MS
      );
      assertLatencyWithinBudget(
        `Connector ${index} client-disconnected callback`,
        startedAt,
        clientDisconnected[index][0].at,
        DISCONNECT_CALLBACK_LATENCY_BUDGET_MS
      );
    }

    await waitFor(() => {
      const nodes = readTrace(tracePath).filter(
        (node) => traceTimestamp(node) >= startedAt - 5
      );
      const disconnected = nodes.filter(
        (node) => node.event === "control_socket_disconnected"
      );
      const replacementConnected = nodes.filter(
        (node) =>
          node.event === "control_socket_connected" &&
          node.metadata?.activeControlCount <= connectors.length
      );
      return (
        disconnected.length >= connectors.length &&
        replacementConnected.some(
          (node) => node.metadata.activeControlCount === connectors.length
        )
      );
    }, 5000);

    const daemonCycle = readTrace(tracePath).filter(
      (node) => traceTimestamp(node) >= startedAt - 5
    );
    const daemonDisconnected = daemonCycle.filter(
      (node) => node.event === "control_socket_disconnected"
    );
    assert.deepStrictEqual(
      daemonDisconnected
        .slice(0, connectors.length)
        .map((node) => node.metadata.activeControlCount),
      [0, 0, 0],
      "Daemon shutdown clears the active set before invoking every disconnect callback"
    );
    daemonDisconnected.slice(0, connectors.length).forEach((node, index) => {
      assertTraceLatencyWithinBudget(
        `Daemon disconnect callback ${index}`,
        startedAt,
        node,
        DISCONNECT_CALLBACK_LATENCY_BUDGET_MS
      );
    });
    assert(
      daemonCycle.some(
        (node) =>
          node.event === "control_socket_connected" &&
          node.metadata.activeControlCount === connectors.length
      ),
      "the replacement Daemon should invoke connect callbacks for all Connectors"
    );

    await assertEveryConnectorUsable(connectors);

    const daemonCallbacks = await waitFor(() => {
      const callbacks = readDaemonControlCallbacks(context, daemonLogOffset);
      const oldDisconnected = callbacks.filter(
        (entry) =>
          entry.event === "control-disconnected-callback" &&
          entry.pid === initialInfo.pid
      );
      const replacementConnected = callbacks.filter(
        (entry) =>
          entry.event === "control-connected-callback" &&
          entry.pid === nextInfo.pid
      );
      return (
        oldDisconnected.length === connectors.length &&
        replacementConnected.length === connectors.length &&
        callbacks
      );
    }, 3000);
    const oldDaemonDisconnectedCallbacks = daemonCallbacks
      .filter(
        (entry) =>
          entry.event === "control-disconnected-callback" &&
          entry.pid === initialInfo.pid
      )
      .sort((left, right) => left.controlId - right.controlId);
    const replacementConnectedCallbacks = daemonCallbacks.filter(
      (entry) =>
        entry.event === "control-connected-callback" &&
        entry.pid === nextInfo.pid
    );
    const connectorMetrics = connectors.map((_connector, index) => ({
      connector: index,
      controlId: index + 1,
      actionToDaemonDisconnect: elapsedMonotonicMs(
        startedAtNs,
        oldDaemonDisconnectedCallbacks[index].monotonicAtNs
      ),
      daemonDisconnectToConnectorCallback: elapsedMonotonicMs(
        oldDaemonDisconnectedCallbacks[index].monotonicAtNs,
        observations[index].states[stateOffsets[index]].monotonicAtNs
      ),
      daemonDisconnectToDeviceCallback: elapsedMonotonicMs(
        oldDaemonDisconnectedCallbacks[index].monotonicAtNs,
        deviceDisconnected[index][0].monotonicAtNs
      ),
      daemonDisconnectToClientCallback: elapsedMonotonicMs(
        oldDaemonDisconnectedCallbacks[index].monotonicAtNs,
        clientDisconnected[index][0].monotonicAtNs
      ),
      actionToConnectorRecovered: elapsedMonotonicMs(
        startedAtNs,
        observations[index].states[stateOffsets[index] + 1].monotonicAtNs
      ),
    }));
    logReliabilityResult({
      scenario: "daemon_shutdown_and_replacement",
      direction: "daemon_to_all_connectors",
      oldDaemonPid: initialInfo.pid,
      replacementDaemonPid: nextInfo.pid,
      connectors: connectorMetrics,
      summaryMs: {
        daemonDisconnectToConnectorCallback: summarizeMs(
          connectorMetrics.map(
            (metric) => metric.daemonDisconnectToConnectorCallback
          )
        ),
        daemonDisconnectToDeviceCallback: summarizeMs(
          connectorMetrics.map(
            (metric) => metric.daemonDisconnectToDeviceCallback
          )
        ),
        daemonDisconnectToClientCallback: summarizeMs(
          connectorMetrics.map(
            (metric) => metric.daemonDisconnectToClientCallback
          )
        ),
        actionToConnectorRecovered: summarizeMs(
          connectorMetrics.map((metric) => metric.actionToConnectorRecovered)
        ),
      },
      actionToReplacementDaemonAcceptedAll: elapsedMonotonicMs(
        startedAtNs,
        replacementConnectedCallbacks
          .map((entry) => BigInt(entry.monotonicAtNs))
          .reduce((latest, current) => (current > latest ? current : latest))
          .toString()
      ),
      clock: "process.hrtime.bigint",
    });
  });

  it("measures bidirectional close callback latency under high Connector churn", async function () {
    this.timeout(platformTimeout(60000));

    const setup = await createConnectedScenario(
      "control-ws-high-volume",
      STRESS_CONNECTOR_COUNT
    );
    const { connectors, observations } = setup;
    const connectorToDaemonLatencies = [];
    const daemonToConnectorLatencies = [];

    for (
      let round = 0;
      round < STRESS_CLOSES_PER_CONNECTOR_PER_DIRECTION;
      round++
    ) {
      for (
        let connectorIndex = 0;
        connectorIndex < connectors.length;
        connectorIndex++
      ) {
        const connector = connectors[connectorIndex];
        const stateOffset = observations[connectorIndex].states.length;
        const daemonLogOffset = context.readLog().length;

        await reconnectDaemonClient(connector.daemonClient);
        const daemonCallbacks = await waitForDaemonControlCallbackPair(
          context,
          daemonLogOffset
        );
        await waitFor(
          () =>
            observations[connectorIndex].states.length === stateOffset + 2 &&
            connector.devices.has("device-1"),
          3000
        );
        await delay(150);

        const connectorCycle = observations[connectorIndex].states.slice(
          stateOffset
        );
        assert.deepStrictEqual(
          connectorCycle.map(({ state }) => state),
          ["disconnected", "connected"]
        );
        const daemonDisconnected = daemonCallbacks.find(
          (entry) => entry.event === "control-disconnected-callback"
        );
        const daemonConnected = daemonCallbacks.find(
          (entry) => entry.event === "control-connected-callback"
        );
        connectorToDaemonLatencies.push(
          elapsedMonotonicMs(
            connectorCycle[0].monotonicAtNs,
            daemonDisconnected.monotonicAtNs
          )
        );
        assert(Number.isInteger(daemonConnected.controlId));
      }
    }

    for (
      let round = 0;
      round < STRESS_CLOSES_PER_CONNECTOR_PER_DIRECTION;
      round++
    ) {
      for (
        let connectorIndex = 0;
        connectorIndex < connectors.length;
        connectorIndex++
      ) {
        const connector = connectors[connectorIndex];
        const stateOffset = observations[connectorIndex].states.length;
        const daemonLogOffset = context.readLog().length;

        context.appendCommand({
          type: "emit-control-socket-error",
          message: `high-volume round ${round} connector ${connectorIndex}`,
        });
        const daemonCallbacks = await waitForDaemonControlCallbackPair(
          context,
          daemonLogOffset
        );
        await waitFor(
          () =>
            observations[connectorIndex].states.length === stateOffset + 2 &&
            connector.devices.has("device-1"),
          3000
        );

        const connectorCycle = observations[connectorIndex].states.slice(
          stateOffset
        );
        assert.deepStrictEqual(
          connectorCycle.map(({ state }) => state),
          ["disconnected", "connected"]
        );
        const daemonDisconnected = daemonCallbacks.find(
          (entry) => entry.event === "control-disconnected-callback"
        );
        const daemonConnected = daemonCallbacks.find(
          (entry) => entry.event === "control-connected-callback"
        );
        daemonToConnectorLatencies.push(
          elapsedMonotonicMs(
            daemonDisconnected.monotonicAtNs,
            connectorCycle[0].monotonicAtNs
          )
        );
        assert(Number.isInteger(daemonConnected.controlId));
      }
    }

    const expectedConnectionEventCount =
      1 + STRESS_CLOSES_PER_CONNECTOR_PER_DIRECTION * 2 * 2;
    assert(
      observations.every(
        ({ states }) => states.length === expectedConnectionEventCount
      ),
      "every requested close should produce exactly one disconnect/reconnect callback pair"
    );
    await assertEveryConnectorUsable(connectors);

    logReliabilityResult({
      scenario: "high_volume_bidirectional_close",
      clock: "process.hrtime.bigint",
      connectorCount: STRESS_CONNECTOR_COUNT,
      closesPerConnectorPerDirection: STRESS_CLOSES_PER_CONNECTOR_PER_DIRECTION,
      connectorToDaemon: {
        closeCount: connectorToDaemonLatencies.length,
        callbackMissingCount:
          STRESS_CONNECTOR_COUNT * STRESS_CLOSES_PER_CONNECTOR_PER_DIRECTION -
          connectorToDaemonLatencies.length,
        latencyMs: summarizeMs(connectorToDaemonLatencies),
      },
      daemonToConnector: {
        closeCount: daemonToConnectorLatencies.length,
        callbackMissingCount:
          STRESS_CONNECTOR_COUNT * STRESS_CLOSES_PER_CONNECTOR_PER_DIRECTION -
          daemonToConnectorLatencies.length,
        latencyMs: summarizeMs(daemonToConnectorLatencies),
      },
      totalCloseCount:
        connectorToDaemonLatencies.length + daemonToConnectorLatencies.length,
    });
  });

  async function createConnectedScenario(
    name,
    connectorCount,
    withClients = false
  ) {
    context = createIntegrationContext(name, {
      readyPollInterval: 10,
      replacementTimeout: 20,
      multiplexerDaemonIdleTimeout: 30000,
    });
    const tracePath = path.join(context.rootDir, "control-reliability.ndjson");
    const connectors = Array.from({ length: connectorCount }, () =>
      context.createConnector({
        connectionTrace: {
          enabled: true,
          output: tracePath,
        },
        rpcTimeout: 3000,
      })
    );
    const observations = connectors.map(observeConnectionEvents);

    // Sequential startup keeps control IDs and round-robin failure order
    // deterministic while still sharing one real child-process Daemon.
    for (let index = 0; index < connectors.length; index++) {
      const connector = connectors[index];
      try {
        await connector.connectDevices(-1, null, true);
        if (withClients) {
          await connector.connectUsbClients("device-1", -1, true, null);
        }
      } catch (error) {
        error.message += `; connector=${index}, daemonProcessName=${
          context.paths.daemonProcessName
        }, daemonLog=${JSON.stringify(context.readLog())}`;
        throw error;
      }
    }
    await waitFor(
      () =>
        readTrace(tracePath).filter(
          (node) => node.event === "control_socket_connected"
        ).length === connectorCount,
      4000
    );
    assert(
      observations.every(
        ({ states }) => states.length === 1 && states[0].state === "connected"
      ),
      "every Connector should start with one connected callback"
    );
    return { connectors, observations, tracePath };
  }

  function stopDaemonFromDaemonSide(info) {
    if (process.platform === "win32") {
      return context.manager.tryGracefullyStopDaemon(info, "stale-daemon");
    }
    process.kill(info.pid, "SIGTERM");
    return Promise.resolve();
  }
});

function observeConnectionEvents(connector) {
  const states = [];
  // Keep the production listener single-owner. This white-box test wraps the
  // emission point only to record callback ordering and latency.
  const emitConnectionEvent = connector.daemonClient.emitConnectionEvent.bind(
    connector.daemonClient
  );
  connector.daemonClient.emitConnectionEvent = (event) => {
    emitConnectionEvent(event);
    states.push({
      state: event.state,
      error: event.state === "disconnected" ? event.error.message : undefined,
      at: Date.now(),
      monotonicAtNs: monotonicNowNs(),
    });
  };
  return { states };
}

async function assertEveryConnectorUsable(connectors) {
  const results = await Promise.all(
    connectors.map((connector) => connector.connectDevices(-1, null, true))
  );
  for (const devices of results) {
    assert.deepStrictEqual(
      devices.map((device) => device.serial),
      ["device-1"]
    );
  }
}

function readTrace(tracePath) {
  try {
    return fs
      .readFileSync(tracePath, "utf8")
      .split(/\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch (_error) {
          return [];
        }
      });
  } catch (_error) {
    return [];
  }
}

function readControlTrace(tracePath, offset) {
  return readTrace(tracePath)
    .slice(offset)
    .filter(
      (node) =>
        node.event === "control_socket_connected" ||
        node.event === "control_socket_disconnected"
    );
}

function traceTimestamp(node) {
  return Date.parse(node.timestamp);
}

function readDaemonControlCallbacks(context, offset) {
  return context
    .readLog()
    .slice(offset)
    .filter(
      (entry) =>
        entry.event === "control-connected-callback" ||
        entry.event === "control-disconnected-callback"
    );
}

function waitForDaemonControlCallbackPair(context, offset) {
  return waitFor(() => {
    const callbacks = readDaemonControlCallbacks(context, offset);
    return (
      callbacks.some(
        (entry) => entry.event === "control-disconnected-callback"
      ) &&
      callbacks.some((entry) => entry.event === "control-connected-callback") &&
      callbacks
    );
  }, 3000);
}

function monotonicNowNs() {
  return process.hrtime.bigint().toString();
}

function elapsedMonotonicMs(startedAtNs, observedAtNs) {
  const elapsedNs = BigInt(observedAtNs) - BigInt(startedAtNs);
  return Number((Number(elapsedNs) / 1_000_000).toFixed(3));
}

function summarizeMs(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    avg: Number((total / values.length).toFixed(3)),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1],
  };
}

function percentile(sortedValues, percentileValue) {
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * percentileValue) - 1)
  );
  return sortedValues[index];
}

function logReliabilityResult(result) {
  console.log(`[control-ws-reliability] ${JSON.stringify(result)}`);
}

function assertTraceLatencyWithinBudget(label, startedAt, node, budget) {
  assertLatencyWithinBudget(label, startedAt, traceTimestamp(node), budget);
}

function assertLatencyWithinBudget(label, startedAt, observedAt, budget) {
  const latency = observedAt - startedAt;
  assert(
    latency >= 0 && latency <= budget,
    `${label} latency ${latency}ms exceeded ${budget}ms budget`
  );
}
