# Single instance by construction

The rate budget (token bucket and queues) and the cached agent token live in process memory, so st-gateway runs as exactly one instance: it scales up, not out. A second instance would mean two budgets against one SpaceTraders limit; going multi-instance needs a shared budget first.

Source: `README.md#Known limitations` (Single instance)
