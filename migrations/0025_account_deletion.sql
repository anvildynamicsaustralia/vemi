-- VEMI-013 account. A person may ask for their account to go. `delete_on` is the moment it
-- will be removed, an ISO time seven days after they asked; empty means no one has asked, and
-- asking again is cancelled by clearing it. Until that moment nothing changes and sign-in
-- works. A daily job removes the accounts whose time has come. Plain statements only, no
-- BEGIN or COMMIT.

ALTER TABLE account ADD COLUMN delete_on TEXT;
