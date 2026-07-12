# Database Schema: Facebook Multi-Page Publisher

This document describes the PostgreSQL database schema modeled via Prisma ORM for the Facebook Multi-Page Publisher.

---

## 1. Relational Database Schema Diagram

```
+------------------+          +-----------------------+          +-------------------+
|      User        |          |    FacebookAccount    |          |   FacebookPage    |
+------------------+          +-----------------------+          +-------------------+
| id (PK)          |1        N| id (PK)               |1        N| id (PK)           |
| email            |----------| userId (FK)           |----------| accountId (FK)    |
| passwordHash     |          | facebookUserId        |          | facebookPageId    |
| createdAt        |          | encryptedAccessToken  |          | pageName          |
| updatedAt        |          | tokenExpiresAt        |          | pageCategory      |
+------------------+          | name                  |          | pagePictureUrl    |
                              | createdAt             |          | encryptedPageToken|
                              | updatedAt             |          | isSynced          |
                              +-----------------------+          | createdAt         |
                                                                 | updatedAt         |
                                                                 +-------------------+
                                                                           | 1
                                                                           |
                                                                           | N
                                                                 +-------------------+
                                                                 |     VideoJob      |
                                                                 +-------------------+
                                                                 | id (PK)           |
                                                                 | pageId (FK)       |
                                                                 | gcsVideoUri       |
                                                                 | gcsThumbnailUri   |
                                                                 | englishTitle      |
                                                                 | englishCaption    |
                                                                 | hashtags          |
                                                                 | scheduledTimeUTC  |
                                                                 | status            |
                                                                 | metaPostId        |
                                                                 | cloudTaskName     |
                                                                 | retryCount        |
                                                                 | errorLog          |
                                                                 | createdAt         |
                                                                 | updatedAt         |
                                                                 +-------------------+
```

---

## 2. Table Definitions

### 2.1. User Table
Stores credentials and basic identity for the application administrator.
- `id` (UUID, Primary Key): Unique identifier.
- `email` (VARCHAR(255), Unique): Email address used for dashboard login.
- `passwordHash` (TEXT): Secure bcrypt hash of the admin dashboard password.
- `createdAt` (TIMESTAMP, Default: Now): Creation time.
- `updatedAt` (TIMESTAMP): Last updated time.

### 2.2. FacebookAccount Table
Stores connected Meta Facebook profiles of the admin.
- `id` (UUID, Primary Key): Unique identifier.
- `userId` (UUID, Foreign Key -> `User.id`): References the dashboard user.
- `facebookUserId` (VARCHAR(255), Unique): Meta's unique User ID.
- `encryptedAccessToken` (TEXT): Encrypted User Access Token (AES-256-GCM).
- `tokenExpiresAt` (TIMESTAMP): Expiration time of the User Access Token.
- `name` (VARCHAR(255)): Display name of the Facebook user.
- `createdAt` (TIMESTAMP, Default: Now).
- `updatedAt` (TIMESTAMP).

### 2.3. FacebookPage Table
Stores Meta Pages associated with the connected Facebook accounts.
- `id` (UUID, Primary Key): Unique identifier.
- `accountId` (UUID, Foreign Key -> `FacebookAccount.id`): References the owner profile.
- `facebookPageId` (VARCHAR(255), Unique): Meta's unique Page ID.
- `pageName` (VARCHAR(255)): Name of the Facebook page.
- `pageCategory` (VARCHAR(255)): Category description.
- `pagePictureUrl` (TEXT): URL for the page's avatar.
- `encryptedPageToken` (TEXT): Encrypted Page Access Token (AES-256-GCM).
- `isSynced` (BOOLEAN, Default: true): Indicates whether the page is active.
- `createdAt` (TIMESTAMP, Default: Now).
- `updatedAt` (TIMESTAMP).

### 2.4. VideoJob Table
Represents individual scheduled video publishing tasks.
- `id` (UUID, Primary Key): Unique identifier.
- `pageId` (UUID, Foreign Key -> `FacebookPage.id`): The destination page.
- `gcsVideoUri` (TEXT): URI path inside Google Cloud Storage for the video asset.
- `gcsThumbnailUri` (TEXT, Nullable): URI path inside Google Cloud Storage for custom thumbnail.
- `englishTitle` (VARCHAR(255)): Title in English.
- `englishCaption` (TEXT): Caption text in English.
- `hashtags` (TEXT, Nullable): Validated English hashtag strings.
- `scheduledTimeUTC` (TIMESTAMP): The exact publishing time scheduled in UTC.
- `status` (ENUM): The current state of the job (`DRAFT`, `SCHEDULED`, `PUBLISHING`, `PUBLISHED`, `FAILED`).
- `metaPostId` (VARCHAR(255), Nullable): The post or reel ID returned by Meta after successful publishing.
- `cloudTaskName` (TEXT, Nullable): Google Cloud Task name identifier used to update/cancel tasks.
- `retryCount` (INTEGER, Default: 0): Current count of transient retry attempts.
- `errorLog` (TEXT, Nullable): Details of API errors when a publishing attempt fails.
- `createdAt` (TIMESTAMP, Default: Now).
- `updatedAt` (TIMESTAMP).

---

## 3. Prisma Schema Definition

This code snippet serves as the schema blueprint:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

enum JobStatus {
  DRAFT
  SCHEDULED
  PUBLISHING
  PUBLISHED
  FAILED
}

model User {
  id               String            @id @default(uuid()) @db.Uuid
  email            String            @unique @db.VarChar(255)
  passwordHash     String
  facebookAccounts FacebookAccount[]
  createdAt        DateTime          @default(now()) @db.Timestamptz
  updatedAt        DateTime          @updatedAt @db.Timestamptz
}

model FacebookAccount {
  id                   String         @id @default(uuid()) @db.Uuid
  userId               String         @db.Uuid
  user                 User           @relation(fields: [userId], references: [id], onDelete: Cascade)
  facebookUserId       String         @unique @db.VarChar(255)
  encryptedAccessToken String         @db.Text
  tokenExpiresAt       DateTime       @db.Timestamptz
  name                 String         @db.VarChar(255)
  pages                FacebookPage[]
  createdAt            DateTime       @default(now()) @db.Timestamptz
  updatedAt            DateTime       @updatedAt @db.Timestamptz

  @@index([facebookUserId])
}

model FacebookPage {
  id                 String          @id @default(uuid()) @db.Uuid
  accountId          String          @db.Uuid
  facebookAccount    FacebookAccount @relation(fields: [accountId], references: [id], onDelete: Cascade)
  facebookPageId     String          @unique @db.VarChar(255)
  pageName           String          @db.VarChar(255)
  pageCategory       String          @db.VarChar(255)
  pagePictureUrl     String          @db.Text
  encryptedPageToken String          @db.Text
  isSynced           Boolean         @default(true)
  videoJobs          VideoJob[]
  createdAt          DateTime        @default(now()) @db.Timestamptz
  updatedAt          DateTime        @updatedAt @db.Timestamptz

  @@index([facebookPageId])
}

model VideoJob {
  id               String       @id @default(uuid()) @db.Uuid
  pageId           String       @db.Uuid
  facebookPage     FacebookPage @relation(fields: [pageId], references: [id], onDelete: Cascade)
  gcsVideoUri      String       @db.Text
  gcsThumbnailUri  String?      @db.Text
  englishTitle     String       @db.VarChar(255)
  englishCaption   String       @db.Text
  hashtags         String?      @db.Text
  scheduledTimeUTC DateTime     @db.Timestamptz
  status           JobStatus    @default(DRAFT)
  metaPostId       String?      @db.VarChar(255)
  cloudTaskName    String?      @db.Text
  retryCount       Int          @default(0) @db.Integer
  errorLog         String?      @db.Text
  createdAt        DateTime     @default(now()) @db.Timestamptz
  updatedAt        DateTime     @updatedAt @db.Timestamptz

  @@index([status])
  @@index([scheduledTimeUTC])
  @@index([pageId])
}
```

---

## 4. Key Security Controls in Schema
- **No Passwords stored for Facebook**: Only the local User table stores a password hash (`passwordHash`) which is hashed using bcrypt.
- **Access Tokens**: Access tokens are stored as `encryptedAccessToken` and `encryptedPageToken`. At the DB layer, these appear as secure strings and must never be stored in plain text.
- **Indices**: Indexes on critical fields like `facebookPageId`, `scheduledTimeUTC`, and `status` optimize query performance during scheduled polling or UI updates.
