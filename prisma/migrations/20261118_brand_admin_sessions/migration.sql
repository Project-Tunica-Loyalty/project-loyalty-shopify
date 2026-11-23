CREATE TABLE "BrandAdminSession" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "staffId" TEXT NOT NULL,
  "encryptedTokens" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "BrandAdminSession_shop_idx" ON "BrandAdminSession"("shop");
CREATE INDEX "BrandAdminSession_expiresAt_idx" ON "BrandAdminSession"("expiresAt");
CREATE TABLE "CustomerDataRequest" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "shop" TEXT NOT NULL,
  "subjectHash" TEXT,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "encryptedResult" TEXT NOT NULL
);
CREATE INDEX "CustomerDataRequest_shop_requestedAt_idx" ON "CustomerDataRequest"("shop", "requestedAt");
