# GahahaDB

> “Dashboard queries are hammering the database?”
>
> “The customer's entire dataset is only a few hundred MB.  
> Just download the whole thing into the browser and run OLAP there.”
>
> **Gahaha.**

GahahaDB is an experimental architecture for running analytical dashboard queries entirely in the browser.

The idea is simple:

**Instead of sending every query to the server, send the data to the client once.**

```text
Traditional analytics

Browser
   |
   | query
   v
Server
   |
   | query
   v
Database
   |
   | result
   v
Browser
```

```text
GahahaDB

Server
   |
   | authorized analytical dataset
   v
Browser
   |
   +--> local OLAP engine
   |
   +--> query
   +--> filter
   +--> aggregate
   +--> visualize
```

For many dashboards, the total database may be huge while the data visible to a single customer is relatively small: tens or hundreds of megabytes, sometimes a few gigabytes.

Modern browsers run on machines with multiple CPU cores, gigabytes of memory, WebAssembly, and highly optimized analytical engines.

So instead of paying for centralized compute every time someone changes a filter:

**give the customer their data and let their computer do the work.**

GahahaDB is based on a few assumptions:

- the dataset authorized for one user or tenant is small enough to download;
- analytical queries are much more frequent than dataset updates;
- some staleness is acceptable;
- data can be represented efficiently in a columnar format;
- the browser is powerful enough to perform the required OLAP workload.

The server is still responsible for authentication, authorization, dataset generation, and delivery.

The browser is responsible for interactive analytics.

This distinction is important:

> If a byte is sent to the browser, assume the user can read it.

GahahaDB therefore does **not** move authorization into the client. Data that a user must not access must never be included in the dataset sent to that user.

The goal is not literally zero server load.

The goal is:

> **zero server-side query compute for interactive dashboard operations after the data has been delivered.**

Storage, snapshot generation, refresh, and network transfer still exist.

But if a dashboard executes hundreds of aggregations over the same few hundred megabytes of customer data, repeatedly asking a centralized OLAP server to do those aggregations may simply be unnecessary.

GahahaDB explores how far we can take the apparently ridiculous idea:

> **Just download the database. Gahaha.**

## License

Apache License 2.0
