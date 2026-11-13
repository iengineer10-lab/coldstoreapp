# Cold store server

## Staff accounts

Open the admin page at `/admin`, select **Staff accounts**, and enter the
staff member's name, username, password, and store. Create the store first if
it does not appear in the list. Usernames are unique across all stores and
passwords must contain at least eight characters.

The staff member signs in to the Android app with that username and password.
Each account can access orders and stock for its assigned store. Passwords
cannot be viewed on the account page. Share credentials securely and use HTTPS
for the admin page and app API.

The server must be restarted after updating its code. Existing databases are
updated on server startup.
