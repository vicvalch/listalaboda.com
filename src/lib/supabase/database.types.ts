
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {

  "public": {
          Tables: {
            "automatic_rsvp_reminders": {
                  Row: {
                    "attempt_count": number,"claim_token": string | null,"created_at": string,"due_at": string,"first_attempt_at": string | null,"guest_invitation_id": string,"id": string,"lease_expires_at": string | null,"next_attempt_at": string | null,"outcome_reason": Database["public"]['Enums']["automatic_rsvp_reminder_outcome_reason"] | null,"sent_at": string | null,"state": Database["public"]['Enums']["automatic_rsvp_reminder_state"],"updated_at": string,"wedding_id": string
                  }
                  Insert: {
                    "attempt_count"?: number,"claim_token"?: string | null,"created_at"?: string,"due_at": string,"first_attempt_at"?: string | null,"guest_invitation_id": string,"id"?: string,"lease_expires_at"?: string | null,"next_attempt_at"?: string | null,"outcome_reason"?: Database["public"]['Enums']["automatic_rsvp_reminder_outcome_reason"] | null,"sent_at"?: string | null,"state": Database["public"]['Enums']["automatic_rsvp_reminder_state"],"updated_at"?: string,"wedding_id": string
                  }
                  Update: {
                    "attempt_count"?: number,"claim_token"?: string | null,"created_at"?: string,"due_at"?: string,"first_attempt_at"?: string | null,"guest_invitation_id"?: string,"id"?: string,"lease_expires_at"?: string | null,"next_attempt_at"?: string | null,"outcome_reason"?: Database["public"]['Enums']["automatic_rsvp_reminder_outcome_reason"] | null,"sent_at"?: string | null,"state"?: Database["public"]['Enums']["automatic_rsvp_reminder_state"],"updated_at"?: string,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "automatic_rsvp_reminders_party_same_wedding"
      columns: ["guest_invitation_id","wedding_id"]
isOneToOne: false
      referencedRelation: "guest_invitations"
      referencedColumns: ["id","wedding_id"]
    },{
      foreignKeyName: "automatic_rsvp_reminders_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    }
                  ]
                },"checklist_items": {
                  Row: {
                    "assignee_membership_id": string | null,"category": Database["public"]['Enums']["checklist_category"] | null,"completed_at": string | null,"completed_by": string | null,"created_at": string,"created_by": string | null,"description": string | null,"due_date": string | null,"guest_invitation_id": string | null,"id": string,"relative_days": number | null,"sort_order": number,"source_template_item_id": string | null,"status": Database["public"]['Enums']["checklist_item_status"],"timing_mode": Database["public"]['Enums']["checklist_timing_mode"],"title": string,"updated_at": string,"wedding_id": string
                  }
                  Insert: {
                    "assignee_membership_id"?: string | null,"category"?: Database["public"]['Enums']["checklist_category"] | null,"completed_at"?: string | null,"completed_by"?: string | null,"created_at"?: string,"created_by"?: string | null,"description"?: string | null,"due_date"?: string | null,"guest_invitation_id"?: string | null,"id"?: string,"relative_days"?: number | null,"sort_order"?: number,"source_template_item_id"?: string | null,"status"?: Database["public"]['Enums']["checklist_item_status"],"timing_mode"?: Database["public"]['Enums']["checklist_timing_mode"],"title": string,"updated_at"?: string,"wedding_id": string
                  }
                  Update: {
                    "assignee_membership_id"?: string | null,"category"?: Database["public"]['Enums']["checklist_category"] | null,"completed_at"?: string | null,"completed_by"?: string | null,"created_at"?: string,"created_by"?: string | null,"description"?: string | null,"due_date"?: string | null,"guest_invitation_id"?: string | null,"id"?: string,"relative_days"?: number | null,"sort_order"?: number,"source_template_item_id"?: string | null,"status"?: Database["public"]['Enums']["checklist_item_status"],"timing_mode"?: Database["public"]['Enums']["checklist_timing_mode"],"title"?: string,"updated_at"?: string,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "checklist_items_assignee_same_wedding"
      columns: ["assignee_membership_id","wedding_id"]
isOneToOne: false
      referencedRelation: "wedding_memberships"
      referencedColumns: ["id","wedding_id"]
    },{
      foreignKeyName: "checklist_items_guest_invitation_same_wedding"
      columns: ["guest_invitation_id","wedding_id"]
isOneToOne: false
      referencedRelation: "guest_invitations"
      referencedColumns: ["id","wedding_id"]
    },{
      foreignKeyName: "checklist_items_source_template_item_id_fkey"
      columns: ["source_template_item_id"]
isOneToOne: false
      referencedRelation: "checklist_template_items"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "checklist_items_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    }
                  ]
                },"checklist_template_items": {
                  Row: {
                    "category": Database["public"]['Enums']["checklist_category"],"created_at": string,"description": string | null,"id": string,"relative_days": number | null,"sort_order": number,"stable_key": string,"template_id": string,"timing_mode": Database["public"]['Enums']["checklist_timing_mode"],"title": string,"updated_at": string
                  }
                  Insert: {
                    "category": Database["public"]['Enums']["checklist_category"],"created_at"?: string,"description"?: string | null,"id"?: string,"relative_days"?: number | null,"sort_order": number,"stable_key": string,"template_id": string,"timing_mode"?: Database["public"]['Enums']["checklist_timing_mode"],"title": string,"updated_at"?: string
                  }
                  Update: {
                    "category"?: Database["public"]['Enums']["checklist_category"],"created_at"?: string,"description"?: string | null,"id"?: string,"relative_days"?: number | null,"sort_order"?: number,"stable_key"?: string,"template_id"?: string,"timing_mode"?: Database["public"]['Enums']["checklist_timing_mode"],"title"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "checklist_template_items_template_id_fkey"
      columns: ["template_id"]
isOneToOne: false
      referencedRelation: "checklist_templates"
      referencedColumns: ["id"]
    }
                  ]
                },"checklist_templates": {
                  Row: {
                    "created_at": string,"description": string | null,"id": string,"is_active": boolean,"key": string,"locale": string,"name": string,"updated_at": string,"version": number
                  }
                  Insert: {
                    "created_at"?: string,"description"?: string | null,"id"?: string,"is_active"?: boolean,"key": string,"locale": string,"name": string,"updated_at"?: string,"version": number
                  }
                  Update: {
                    "created_at"?: string,"description"?: string | null,"id"?: string,"is_active"?: boolean,"key"?: string,"locale"?: string,"name"?: string,"updated_at"?: string,"version"?: number
                  }
                  Relationships: [

                  ]
                },"content_sections": {
                  Row: {
                    "body": string | null,"created_at": string,"id": string,"is_visible": boolean,"kind": Database["public"]['Enums']["content_section_kind"],"title": string | null,"updated_at": string,"wedding_id": string
                  }
                  Insert: {
                    "body"?: string | null,"created_at"?: string,"id"?: string,"is_visible"?: boolean,"kind": Database["public"]['Enums']["content_section_kind"],"title"?: string | null,"updated_at"?: string,"wedding_id": string
                  }
                  Update: {
                    "body"?: string | null,"created_at"?: string,"id"?: string,"is_visible"?: boolean,"kind"?: Database["public"]['Enums']["content_section_kind"],"title"?: string | null,"updated_at"?: string,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "content_sections_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    }
                  ]
                },"email_deliveries": {
                  Row: {
                    "accepted_at": string,"guest_invitation_id": string,"id": string,"kind": Database["public"]['Enums']["email_delivery_kind"],"provider_message_id": string,"recipient": string,"wedding_id": string
                  }
                  Insert: {
                    "accepted_at"?: string,"guest_invitation_id": string,"id"?: string,"kind": Database["public"]['Enums']["email_delivery_kind"],"provider_message_id": string,"recipient": string,"wedding_id": string
                  }
                  Update: {
                    "accepted_at"?: string,"guest_invitation_id"?: string,"id"?: string,"kind"?: Database["public"]['Enums']["email_delivery_kind"],"provider_message_id"?: string,"recipient"?: string,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "email_deliveries_party_same_wedding"
      columns: ["guest_invitation_id","wedding_id"]
isOneToOne: false
      referencedRelation: "guest_invitations"
      referencedColumns: ["id","wedding_id"]
    },{
      foreignKeyName: "email_deliveries_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    }
                  ]
                },"guest_invitations": {
                  Row: {
                    "contact_email": string | null,"created_at": string,"created_by": string | null,"id": string,"invitation_email_provider_id": string | null,"invitation_email_sent_at": string | null,"invitation_email_sent_to": string | null,"label": string,"revoked_at": string | null,"rsvp_confirmation_email_provider_id": string | null,"rsvp_confirmation_email_sent_at": string | null,"rsvp_confirmation_email_sent_to": string | null,"rsvp_reminder_email_provider_id": string | null,"rsvp_reminder_email_sent_at": string | null,"rsvp_reminder_email_sent_to": string | null,"token_hash": string,"token_issued_at": string,"updated_at": string,"wedding_id": string
                  }
                  Insert: {
                    "contact_email"?: string | null,"created_at"?: string,"created_by"?: string | null,"id"?: string,"invitation_email_provider_id"?: string | null,"invitation_email_sent_at"?: string | null,"invitation_email_sent_to"?: string | null,"label": string,"revoked_at"?: string | null,"rsvp_confirmation_email_provider_id"?: string | null,"rsvp_confirmation_email_sent_at"?: string | null,"rsvp_confirmation_email_sent_to"?: string | null,"rsvp_reminder_email_provider_id"?: string | null,"rsvp_reminder_email_sent_at"?: string | null,"rsvp_reminder_email_sent_to"?: string | null,"token_hash": string,"token_issued_at"?: string,"updated_at"?: string,"wedding_id": string
                  }
                  Update: {
                    "contact_email"?: string | null,"created_at"?: string,"created_by"?: string | null,"id"?: string,"invitation_email_provider_id"?: string | null,"invitation_email_sent_at"?: string | null,"invitation_email_sent_to"?: string | null,"label"?: string,"revoked_at"?: string | null,"rsvp_confirmation_email_provider_id"?: string | null,"rsvp_confirmation_email_sent_at"?: string | null,"rsvp_confirmation_email_sent_to"?: string | null,"rsvp_reminder_email_provider_id"?: string | null,"rsvp_reminder_email_sent_at"?: string | null,"rsvp_reminder_email_sent_to"?: string | null,"token_hash"?: string,"token_issued_at"?: string,"updated_at"?: string,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "guest_invitations_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    }
                  ]
                },"guests": {
                  Row: {
                    "created_at": string,"guest_invitation_id": string,"id": string,"name": string,"updated_at": string,"wedding_id": string
                  }
                  Insert: {
                    "created_at"?: string,"guest_invitation_id": string,"id"?: string,"name": string,"updated_at"?: string,"wedding_id": string
                  }
                  Update: {
                    "created_at"?: string,"guest_invitation_id"?: string,"id"?: string,"name"?: string,"updated_at"?: string,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "guests_invitation_same_wedding"
      columns: ["guest_invitation_id","wedding_id"]
isOneToOne: false
      referencedRelation: "guest_invitations"
      referencedColumns: ["id","wedding_id"]
    }
                  ]
                },"membership_invites": {
                  Row: {
                    "accepted_at": string | null,"accepted_by": string | null,"created_at": string,"created_by": string | null,"email": string | null,"expires_at": string,"id": string,"intended_role": Database["public"]['Enums']["wedding_role"],"revoked_at": string | null,"token_hash": string,"updated_at": string,"wedding_id": string
                  }
                  Insert: {
                    "accepted_at"?: string | null,"accepted_by"?: string | null,"created_at"?: string,"created_by"?: string | null,"email"?: string | null,"expires_at": string,"id"?: string,"intended_role"?: Database["public"]['Enums']["wedding_role"],"revoked_at"?: string | null,"token_hash": string,"updated_at"?: string,"wedding_id": string
                  }
                  Update: {
                    "accepted_at"?: string | null,"accepted_by"?: string | null,"created_at"?: string,"created_by"?: string | null,"email"?: string | null,"expires_at"?: string,"id"?: string,"intended_role"?: Database["public"]['Enums']["wedding_role"],"revoked_at"?: string | null,"token_hash"?: string,"updated_at"?: string,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "membership_invites_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    }
                  ]
                },"rsvps": {
                  Row: {
                    "attending": boolean,"created_at": string,"dietary_note": string | null,"guest_id": string,"updated_at": string,"wedding_id": string
                  }
                  Insert: {
                    "attending": boolean,"created_at"?: string,"dietary_note"?: string | null,"guest_id": string,"updated_at"?: string,"wedding_id": string
                  }
                  Update: {
                    "attending"?: boolean,"created_at"?: string,"dietary_note"?: string | null,"guest_id"?: string,"updated_at"?: string,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "rsvps_guest_same_wedding"
      columns: ["guest_id","wedding_id"]
isOneToOne: false
      referencedRelation: "guests"
      referencedColumns: ["id","wedding_id"]
    }
                  ]
                },"wedding_activity": {
                  Row: {
                    "actor_kind": Database["public"]['Enums']["wedding_activity_actor"],"actor_user_id": string | null,"event_type": Database["public"]['Enums']["wedding_activity_event"],"guest_invitation_id": string | null,"id": string,"occurred_at": string,"wedding_id": string
                  }
                  Insert: {
                    "actor_kind": Database["public"]['Enums']["wedding_activity_actor"],"actor_user_id"?: string | null,"event_type": Database["public"]['Enums']["wedding_activity_event"],"guest_invitation_id"?: string | null,"id"?: string,"occurred_at"?: string,"wedding_id": string
                  }
                  Update: {
                    "actor_kind"?: Database["public"]['Enums']["wedding_activity_actor"],"actor_user_id"?: string | null,"event_type"?: Database["public"]['Enums']["wedding_activity_event"],"guest_invitation_id"?: string | null,"id"?: string,"occurred_at"?: string,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "wedding_activity_guest_invitation_same_wedding"
      columns: ["guest_invitation_id","wedding_id"]
isOneToOne: false
      referencedRelation: "guest_invitations"
      referencedColumns: ["id","wedding_id"]
    },{
      foreignKeyName: "wedding_activity_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    }
                  ]
                },"wedding_checklist_template_applications": {
                  Row: {
                    "applied_at": string,"applied_by": string | null,"id": string,"template_id": string,"wedding_id": string
                  }
                  Insert: {
                    "applied_at"?: string,"applied_by"?: string | null,"id"?: string,"template_id": string,"wedding_id": string
                  }
                  Update: {
                    "applied_at"?: string,"applied_by"?: string | null,"id"?: string,"template_id"?: string,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "wedding_checklist_template_applications_template_id_fkey"
      columns: ["template_id"]
isOneToOne: false
      referencedRelation: "checklist_templates"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "wedding_checklist_template_applications_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: true
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    }
                  ]
                },"wedding_memberships": {
                  Row: {
                    "created_at": string,"display_name": string | null,"id": string,"role": Database["public"]['Enums']["wedding_role"],"updated_at": string,"user_id": string,"wedding_id": string
                  }
                  Insert: {
                    "created_at"?: string,"display_name"?: string | null,"id"?: string,"role": Database["public"]['Enums']["wedding_role"],"updated_at"?: string,"user_id": string,"wedding_id": string
                  }
                  Update: {
                    "created_at"?: string,"display_name"?: string | null,"id"?: string,"role"?: Database["public"]['Enums']["wedding_role"],"updated_at"?: string,"user_id"?: string,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "wedding_memberships_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: false
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    }
                  ]
                },"wedding_publications": {
                  Row: {
                    "created_at": string,"published_at": string | null,"slug": string,"updated_at": string,"wedding_id": string
                  }
                  Insert: {
                    "created_at"?: string,"published_at"?: string | null,"slug": string,"updated_at"?: string,"wedding_id": string
                  }
                  Update: {
                    "created_at"?: string,"published_at"?: string | null,"slug"?: string,"updated_at"?: string,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "wedding_publications_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: true
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    }
                  ]
                },"wedding_rsvp_reminder_policies": {
                  Row: {
                    "created_at": string,"days_before": number,"enabled": boolean,"enabled_at": string | null,"updated_at": string,"updated_by": string | null,"wedding_id": string
                  }
                  Insert: {
                    "created_at"?: string,"days_before"?: number,"enabled"?: boolean,"enabled_at"?: string | null,"updated_at"?: string,"updated_by"?: string | null,"wedding_id": string
                  }
                  Update: {
                    "created_at"?: string,"days_before"?: number,"enabled"?: boolean,"enabled_at"?: string | null,"updated_at"?: string,"updated_by"?: string | null,"wedding_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "wedding_rsvp_reminder_policies_wedding_id_fkey"
      columns: ["wedding_id"]
isOneToOne: true
      referencedRelation: "weddings"
      referencedColumns: ["id"]
    }
                  ]
                },"weddings": {
                  Row: {
                    "city": string | null,"created_at": string,"created_by": string | null,"id": string,"name": string,"time_zone": string | null,"updated_at": string,"wedding_date": string | null
                  }
                  Insert: {
                    "city"?: string | null,"created_at"?: string,"created_by"?: string | null,"id"?: string,"name": string,"time_zone"?: string | null,"updated_at"?: string,"wedding_date"?: string | null
                  }
                  Update: {
                    "city"?: string | null,"created_at"?: string,"created_by"?: string | null,"id"?: string,"name"?: string,"time_zone"?: string | null,"updated_at"?: string,"wedding_date"?: string | null
                  }
                  Relationships: [

                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "accept_membership_invite":
{ Args: { "invite_token_hash": string }; Returns: {
              "already_member": boolean,"role": Database["public"]['Enums']["wedding_role"],"wedding_id": string
            }[]
                           },
"begin_automatic_rsvp_reminder_send":
{ Args: { "expected_recipient": string,"expected_token_hash": string,"occurrence_claim_token": string,"target_occurrence_id": string }; Returns: {
              "attempt_number": number,"status": string
            }[]
                           },
"claim_automatic_rsvp_reminders":
{ Args: { "max_per_wedding": number,"max_total": number }; Returns: {
              "occurrence_claim_token": string,"occurrence_id": string
            }[]
                           },
"create_guest_invitation":
{ Args: { "guest_names": (string)[],"invitation_token_ciphertext": string,"invitation_token_hash": string,"party_contact_email"?: string,"party_label": string,"target_wedding_id": string }; Returns: string
                           },
"create_wedding":
{ Args: { "wedding_city"?: string,"wedding_date"?: string,"wedding_name": string,"wedding_time_zone"?: string }; Returns: {
              "city": string | null,
"created_at": string,
"created_by": string | null,
"id": string,
"name": string,
"time_zone": string | null,
"updated_at": string,
"wedding_date": string | null
            }
                          SetofOptions: {
        from: "*"
        to: "weddings"
        isOneToOne: true
        isSetofReturn: false
      } },
"finish_automatic_rsvp_reminder":
{ Args: { "occurrence_claim_token": string,"outcome": Database["public"]['Enums']["automatic_rsvp_reminder_finish_outcome"],"target_occurrence_id": string }; Returns: Database["public"]['Enums']["automatic_rsvp_reminder_state"]
                           },
"get_guest_invitation":
{ Args: { "invitation_token_hash": string }; Returns: {
              "attending": boolean,"dietary_note": string,"guest_id": string,"guest_name": string,"party_label": string
            }[]
                           },
"get_guest_invitation_recovery_envelope":
{ Args: { "target_invitation_id": string,"target_wedding_id": string }; Returns: {
              "link_state": string,"token_ciphertext": string,"token_hash": string
            }[]
                           },
"get_guest_invitation_site_slug":
{ Args: { "invitation_token_hash": string }; Returns: string
                           },
"get_published_wedding_site":
{ Args: { "site_slug": string }; Returns: {
              "section_body": string,"section_kind": Database["public"]['Enums']["content_section_kind"],"section_title": string,"wedding_city": string,"wedding_date": string,"wedding_name": string
            }[]
                           },
"get_rsvp_confirmation_email_context":
{ Args: { "invitation_token_hash": string }; Returns: {
              "contact_email": string,"guest_invitation_id": string,"wedding_city": string,"wedding_date": string,"wedding_id": string,"wedding_name": string
            }[]
                           },
"get_wedding_activity":
{ Args: { "max_events"?: number,"target_wedding_id": string }; Returns: {
              "actor_kind": Database["public"]['Enums']["wedding_activity_actor"],"actor_membership_id": string,"event_type": Database["public"]['Enums']["wedding_activity_event"],"guest_invitation_id": string,"id": string,"occurred_at": string,"party_label": string
            }[]
                           },
"guest_invitation_link_is_current":
{ Args: { "invitation_token_hash": string,"target_invitation_id": string,"target_wedding_id": string }; Returns: boolean
                           },
"initialize_wedding_checklist":
{ Args: { "target_wedding_id": string }; Returns: {
              "already_initialized": boolean,"item_count": number,"template_key": string,"template_version": number
            }[]
                           },
"prepare_automatic_rsvp_reminder":
{ Args: { "occurrence_claim_token": string,"target_occurrence_id": string }; Returns: {
              "current_party_label": string,"current_recipient": string,"current_site_slug": string,"current_token_ciphertext": string,"current_token_hash": string,"current_wedding_city": string,"current_wedding_date": string,"current_wedding_name": string,"status": string
            }[]
                           },
"publish_wedding_site":
{ Args: { "target_wedding_id": string }; Returns: string
                           },
"record_automatic_rsvp_reminder_email":
{ Args: { "invitation_token_hash": string,"occurrence_claim_token": string,"provider_message_id": string,"recipient": string,"target_occurrence_id": string }; Returns: string
                           },
"record_guest_invitation_email":
{ Args: { "acting_user_id": string,"invitation_token_hash": string,"provider_message_id": string,"recipient": string,"target_invitation_id": string,"target_wedding_id": string }; Returns: string
                           },
"record_rsvp_confirmation_email":
{ Args: { "invitation_token_hash": string,"provider_message_id": string,"recipient": string,"target_invitation_id": string,"target_wedding_id": string }; Returns: string
                           },
"record_rsvp_reminder_email":
{ Args: { "acting_user_id": string,"invitation_token_hash": string,"provider_message_id": string,"recipient": string,"target_invitation_id": string,"target_wedding_id": string }; Returns: string
                           },
"revoke_guest_invitation_link":
{ Args: { "target_invitation_id": string,"target_wedding_id": string }; Returns: boolean
                           },
"rotate_guest_invitation_link":
{ Args: { "invitation_token_ciphertext": string,"invitation_token_hash": string,"target_invitation_id": string,"target_wedding_id": string }; Returns: boolean
                           },
"save_wedding_site_section":
{ Args: { "section_body": string,"section_kind": Database["public"]['Enums']["content_section_kind"],"section_title": string,"section_visible": boolean,"target_wedding_id": string }; Returns: undefined
                           },
"set_rsvp_reminder_policy":
{ Args: { "reminder_days_before": number,"reminders_enabled": boolean,"target_wedding_id": string }; Returns: boolean
                           },
"set_wedding_display_name":
{ Args: { "new_display_name": string,"target_wedding_id": string }; Returns: string
                           },
"set_wedding_site_slug":
{ Args: { "new_slug": string,"target_wedding_id": string }; Returns: string
                           },
"submit_guest_rsvp":
{ Args: { "invitation_token_hash": string,"responses": Json }; Returns: {
              "attending": boolean,"dietary_note": string,"guest_id": string,"guest_name": string,"party_label": string
            }[]
                           },
"unpublish_wedding_site":
{ Args: { "target_wedding_id": string }; Returns: undefined
                           }
          }
          Enums: {
            "automatic_rsvp_reminder_finish_outcome": "link_unrecoverable"|"sent_unrecorded"|"retry"|"recipient_rejected"|"idempotency_conflict","automatic_rsvp_reminder_outcome_reason": "answered"|"no_contact_email"|"link_unavailable"|"link_unrecoverable"|"recently_reminded"|"policy_disabled"|"out_of_window"|"recipient_rejected"|"ineligible_after_attempt"|"idempotency_conflict"|"attempts_exhausted"|"replay_window_expired","automatic_rsvp_reminder_state": "claimed"|"sending"|"retry_wait"|"sent"|"sent_unrecorded"|"skipped"|"failed"|"unknown","checklist_category": "first_steps"|"venue_and_date"|"vendors"|"attire"|"invitations"|"ceremony"|"reception"|"final_preparations"|"after_wedding","checklist_item_status": "pending"|"done"|"not_applicable","checklist_timing_mode": "none"|"relative_to_wedding"|"absolute","content_section_kind": "intro"|"ceremony"|"reception"|"schedule"|"dress_code"|"faq"|"rsvp","email_delivery_kind": "guest_invitation"|"rsvp_confirmation"|"rsvp_reminder_manual"|"rsvp_reminder_automatic","wedding_activity_actor": "member"|"guest_capability"|"system","wedding_activity_event": "guest_invitation_created"|"guest_invitation_link_rotated"|"guest_invitation_revoked"|"guest_invitation_contact_email_changed"|"guest_invitation_email_sent"|"guest_rsvp_submitted"|"guest_rsvp_updated"|"rsvp_confirmation_email_sent"|"rsvp_reminder_email_sent","wedding_role": "owner"|"collaborator"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "public": {
          Enums: {
            "automatic_rsvp_reminder_finish_outcome": ["link_unrecoverable", "sent_unrecorded", "retry", "recipient_rejected", "idempotency_conflict"],"automatic_rsvp_reminder_outcome_reason": ["answered", "no_contact_email", "link_unavailable", "link_unrecoverable", "recently_reminded", "policy_disabled", "out_of_window", "recipient_rejected", "ineligible_after_attempt", "idempotency_conflict", "attempts_exhausted", "replay_window_expired"],"automatic_rsvp_reminder_state": ["claimed", "sending", "retry_wait", "sent", "sent_unrecorded", "skipped", "failed", "unknown"],"checklist_category": ["first_steps", "venue_and_date", "vendors", "attire", "invitations", "ceremony", "reception", "final_preparations", "after_wedding"],"checklist_item_status": ["pending", "done", "not_applicable"],"checklist_timing_mode": ["none", "relative_to_wedding", "absolute"],"content_section_kind": ["intro", "ceremony", "reception", "schedule", "dress_code", "faq", "rsvp"],"email_delivery_kind": ["guest_invitation", "rsvp_confirmation", "rsvp_reminder_manual", "rsvp_reminder_automatic"],"wedding_activity_actor": ["member", "guest_capability", "system"],"wedding_activity_event": ["guest_invitation_created", "guest_invitation_link_rotated", "guest_invitation_revoked", "guest_invitation_contact_email_changed", "guest_invitation_email_sent", "guest_rsvp_submitted", "guest_rsvp_updated", "rsvp_confirmation_email_sent", "rsvp_reminder_email_sent"],"wedding_role": ["owner", "collaborator"]
          }
        }
} as const
