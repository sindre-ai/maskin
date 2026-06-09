-- Change messages.actor_id FK from NO ACTION to CASCADE so actor deletion does not error
ALTER TABLE "messages" DROP CONSTRAINT "messages_actor_id_actors_id_fk";
ALTER TABLE "messages" ADD CONSTRAINT "messages_actor_id_actors_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."actors"("id") ON DELETE cascade ON UPDATE no action;
