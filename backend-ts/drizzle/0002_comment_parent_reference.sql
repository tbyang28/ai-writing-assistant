-- Preserve replies whose parent was already removed before the FK existed.
UPDATE "comments" AS "reply"
SET "parent_id" = NULL
WHERE "parent_id" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "comments" AS "parent" WHERE "parent"."id" = "reply"."parent_id");
--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_parent_id_comments_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."comments"("id") ON DELETE set null ON UPDATE no action;
