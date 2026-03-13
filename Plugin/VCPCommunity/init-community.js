const CommunityManager = require('./lib/managers/communityManager');

async function main() {
    const communityManager = new CommunityManager();
    const result = await communityManager.initStorage();
    console.log(result);
}

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
