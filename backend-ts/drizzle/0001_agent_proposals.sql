CREATE TABLE "agent_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"book_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"args" text NOT NULL,
	"digest" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"result" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_proposals_tool_check" CHECK ("agent_proposals"."tool" in ('save_character', 'save_inspiration')),
	CONSTRAINT "agent_proposals_status_check" CHECK ("agent_proposals"."status" in ('pending', 'confirmed', 'cancelled')),
	CONSTRAINT "agent_proposals_result_check" CHECK (("agent_proposals"."status" = 'confirmed') = ("agent_proposals"."result" is not null))
);
--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_book_id_books_id_fk" FOREIGN KEY ("book_id") REFERENCES "public"."books"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_proposals" ADD CONSTRAINT "agent_proposals_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_proposals_book_id_idx" ON "agent_proposals" USING btree ("book_id");--> statement-breakpoint
CREATE INDEX "agent_proposals_owner_id_idx" ON "agent_proposals" USING btree ("owner_id");