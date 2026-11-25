# MediGuard

MediGuard is a full-stack application for managing household medication inventories and therapeutic plans, with caregiver support, web push notifications, and IoT integration.

The project combines a Next.js application, a PostgreSQL database, Prisma ORM, and a Docker-based runtime.

## Features

- **Medication inventory:** manage medicines, quantities, expiration dates, and stored medication records.
- **Therapy management:** organize therapeutic plans, dosage information, schedules, and recorded administrations.
- **Caregiver relationships:** connect caregivers and assisted users, with permission-aware access to shared information.
- **Medication and allergy data:** search the medication catalogue and manage user allergy information.
- **Web push notifications:** browser subscriptions and push notifications for application reminders.
- **IoT integration:** API endpoints for device synchronization and confirmation workflows.

## Technology stack

| Area | Technologies |
| --- | --- |
| Frontend and application framework | Next.js 16, React 19 |
| Backend | Next.js Route Handlers |
| Database | PostgreSQL 15 |
| ORM and migrations | Prisma 5 |
| Styling | Tailwind CSS 4, CSS Modules |
| Authentication | JSON Web Tokens, bcryptjs |
| Notifications | Web Push |
| Runtime and packaging | Docker, Docker Compose, Node.js 20 |

## Architecture

The application is organized around three main services:

- **Next.js application:** serves the user interface and backend API routes.
- **PostgreSQL:** stores users, medication inventory, therapies, caregiver relationships, allergies, and notification subscriptions.
- **Prisma:** provides database access and applies the versioned migrations in `prisma/migrations`.

Docker Compose starts the application and database together. PostgreSQL data is persisted in the named `postgres_data` volume.

## Requirements

- Docker Engine and Docker Compose (Docker Desktop is suitable on Windows and macOS).
- Git, to clone the repository.

## Getting started

### 1. Clone the repository

```bash
git clone https://github.com/SebaGra-coder/MediGuard-Full-Stack-Pharmaceutical-Inventory-Management-Platform.git
cd MediGuard-Full-Stack-Pharmaceutical-Inventory-Management-Platform
```

### 2. Configure environment variables

Create the Compose environment file and the application environment file from the example:

```bash
cp .env.example .env
cp .env.example .env.docker
```

On Windows PowerShell, use:

```powershell
Copy-Item .env.example .env
Copy-Item .env.example .env.docker
```

Set your own values for the database password, JWT secret, and VAPID keys. In `.env.docker`, set the database host in `DATABASE_URL` to the Compose service name `postgres` (rather than `localhost`), because the application connects to PostgreSQL over the Docker network.

Do not commit `.env` or `.env.docker`. The committed `.env.example` contains placeholders only.

### 3. Build and start the application

```bash
docker compose up --build -d
```

The application will be available at:

- http://localhost:3000

### 4. Apply database migrations

After the containers are running, apply the migrations included in the repository:

```bash
docker compose exec app npx prisma migrate deploy
```

### 5. Load the initial catalogue data

The repository includes CSV data files and a Prisma seed script. To import the initial medication and allergen data, run:

```bash
docker compose exec app node prisma/seed.js
```

### Useful Docker commands

| Command | Description |
| --- | --- |
| `docker compose ps` | Show the application and database containers. |
| `docker compose logs -f app` | Follow application logs. |
| `docker compose logs -f postgres` | Follow PostgreSQL logs. |
| `docker compose down` | Stop and remove containers while preserving the database volume. |
| `docker compose down -v` | Stop containers and delete the database volume and its data. |

## Repository structure

```text
.
├── prisma/
│   ├── migrations/
│   ├── schema.prisma
│   ├── seed.js
│   └── *.csv
├── public/
├── src/
│   ├── app/
│   │   └── api/
│   ├── components/
│   ├── hooks/
│   └── lib/
├── .dockerignore
├── .env.example
├── docker-compose.yml
├── Dockerfile
├── package.json
└── README.md
```

## Development

For local development outside Docker, install the dependencies with `npm ci`, configure a `DATABASE_URL` that points to a reachable PostgreSQL instance, generate the Prisma Client, and start the Next.js development server:

```bash
npm ci
npx prisma generate
npm run dev
```

The development server runs at http://localhost:3000.

## Project context

MediGuard was developed as a team project. It brings together full-stack web development, relational data modelling, medication-management workflows, caregiver functionality, browser notifications, and device integration.

---

**Note:** MediGuard is a software project for medication inventory and therapy organization. It is not a substitute for professional medical advice, diagnosis, or treatment.
