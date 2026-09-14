# Order status history is a sub-resource of Order, scoped identically, with courier identity withheld

`GET /orders/{orderId}/status-history` needed both a shape and an
authorization rule for CLIENT, MANAGER and DELIVERY. We nested it under the
order and reused the existing `read Order` CASL rule and its 404-never-403
behavior, rather than exposing `OrderStatusHistory` as its own top-level,
`orderId`-filtered collection — that shape would make the rows a resource
whose scope has to be re-derived from a query parameter, which is what turns
a route into an identifier oracle. The payload also never includes
`deliveredById`: `Order.deliveredById` is overwritten by later transitions,
so attributing a DELIVERED row to whoever is currently named there is an
inference, not a recorded fact, and it is personal data about a third party
with no client-facing purpose.

## Considered Options

- A top-level `/order-status-history` collection filtered by `orderId` —
  rejected: it re-derives scope from a query parameter instead of the order's
  own CASL rule, producing an identifier oracle.
- Modeling `OrderStatusHistory` as its own CASL subject with its own
  CLIENT/MANAGER/DELIVERY conditions (mirrored from `getOrder`) — left as a
  documented extension point rather than adopted now, since riding on
  `read Order` already satisfies the matrix.
