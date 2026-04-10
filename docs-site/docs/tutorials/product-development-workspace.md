---
sidebar_position: 1
title: "Tutorial: Product Development Workspace"
---

# Tutorial: Set Up a Product Development Workspace

This tutorial walks you through setting up a complete product development workspace — from installation to having agents process insights, propose bets, and execute tasks.

**Time:** ~10 minutes

## Prerequisites

Complete the [Quick Start](/quick-start) guide first. You should have Maskin running locally with the backend on port 3000.

## Step 1: Create your workspace

```bash
# Create an actor (if you haven't already)
curl -X POST http://localhost:3000/api/actors \
  -H "Content-Type: application/json" \
  -d '{"type": "human", "name": "Product Lead"}'
```

Save the `api_key` and `workspace_id` from the response. Set them as environment variables for convenience:

```bash
export API_KEY="your-api-key"
export WORKSPACE_ID="your-workspace-id"
```

## Step 2: Add some insights

Insights are raw feedback — customer requests, bug reports, observations. Let's add a few:

```bash
# Insight 1: Customer feedback
curl -X POST http://localhost:3000/api/objects \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Workspace-Id: $WORKSPACE_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "insight",
    "title": "Users requesting dark mode",
    "content": "12 support tickets this week asking for dark mode. Several mentioned eye strain during evening use.",
    "status": "new"
  }'

# Insight 2: Bug report
curl -X POST http://localhost:3000/api/objects \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Workspace-Id: $WORKSPACE_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "insight",
    "title": "Dashboard loading slow for large teams",
    "content": "Teams with 50+ members report 5-second load times on the main dashboard.",
    "status": "new"
  }'

# Insight 3: Market signal
curl -X POST http://localhost:3000/api/objects \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Workspace-Id: $WORKSPACE_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "insight",
    "title": "Competitor launched AI assistant feature",
    "content": "Main competitor announced an AI-powered assistant that helps with task prioritization.",
    "status": "new"
  }'
```

## Step 3: Create a bet from insights

A bet is a hypothesis worth testing. Let's create one based on the dark mode feedback and link the insight to it:

```bash
# Create the bet
curl -X POST http://localhost:3000/api/graph \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Workspace-Id: $WORKSPACE_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "objects": [
      {
        "type": "bet",
        "title": "Ship dark mode to reduce churn from evening users",
        "content": "Hypothesis: Adding dark mode will reduce support tickets about eye strain and improve retention for users who work in the evenings.",
        "status": "proposed"
      }
    ]
  }'
```

Save the bet's `id` from the response, then link the insight to it:

```bash
# Connect the insight to the bet
curl -X POST http://localhost:3000/api/relationships \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Workspace-Id: $WORKSPACE_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "source_id": "insight-id-from-step-2",
    "target_id": "bet-id-from-above",
    "type": "informs"
  }'
```

## Step 4: Break the bet into tasks

```bash
# Create tasks linked to the bet using the graph endpoint
curl -X POST http://localhost:3000/api/graph \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Workspace-Id: $WORKSPACE_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "objects": [
      {
        "type": "task",
        "title": "Design dark mode color palette",
        "content": "Create a dark color palette that meets WCAG AA contrast requirements.",
        "status": "todo"
      },
      {
        "type": "task",
        "title": "Implement dark mode toggle in settings",
        "content": "Add a dark mode toggle to user settings. Persist preference in local storage.",
        "status": "todo"
      },
      {
        "type": "task",
        "title": "Test dark mode across all pages",
        "content": "Verify dark mode renders correctly on all pages. Fix any contrast or readability issues.",
        "status": "todo"
      }
    ]
  }'
```

## Step 5: View the workspace

Open [http://localhost:5173](http://localhost:5173) in your browser. You should see:
- Your insights in the Insights view
- Your bet in the Bets view
- Your tasks in the Tasks view
- The relationships connecting them in the graph view

## Step 6: Check the activity log

Every action you've taken has been recorded as an event:

```bash
curl http://localhost:3000/api/events/history \
  -H "Authorization: Bearer $API_KEY" \
  -H "X-Workspace-Id: $WORKSPACE_ID"
```

This returns a chronological log of all mutations — who created what, when, and the full data payload.

## What's next?

- **[Connect an AI agent](/tutorials/connect-ai-agent)** to automate insight processing
- **[Set up triggers](/tutorials/automate-with-triggers)** to fire agents on events or schedules
