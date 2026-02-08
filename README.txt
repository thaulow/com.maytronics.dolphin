Adds support for Maytronics Dolphin range pool cleaners. Before use, please:
1. Create a new account with the script below in a terminal window, where you replace email, password, first and lastname.
2. Sign in to your mobile app with your new account, this will lift the 2 factor authentication.
3. Add your robot to the new account.
4. Sign in to the homey app with your new account.

curl -X POST "https://mbapp18.maytronics.com/api/users/register/" \
     -H "appkey: 346BDE92-53D1-4829-8A2E-B496014B586C" \
     -H "Content-Type: application/x-www-form-urlencoded; charset=utf-8" \
     --data-urlencode 'email=<EMAIL>' \
     --data-urlencode 'password=<PASSWORD>' \
     --data-urlencode 'firstName=<FIRST NAME>' \
     --data-urlencode 'lastName=<LAST NAME>'
