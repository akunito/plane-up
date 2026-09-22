#!/usr/bin/env bash

set -e

DIST_DIR=${DIST_DIR:-./dist}
CPU_ARCH=$(uname -m)
IMAGE_NAME=${IMAGE_NAME:-makeplane/plane-aio-community}


# loop though all flags and set the variables
for arg in "$@"; do
    case $arg in
        --release)
            APP_RELEASE_VERSION="$2"
            shift
            shift
            ;;
        --release=*)
            APP_RELEASE_VERSION="${arg#*=}"
            shift
            ;;
        --image-name)
            IMAGE_NAME="$2"
            shift
            shift
            ;;
        --image-name=*)
            IMAGE_NAME="${arg#*=}"
            shift
            ;;
    esac
done


if [ -z "$APP_RELEASE_VERSION" ]; then
    echo ""
    echo "Usage: "
    echo "   ./build.sh [flags]"
    echo ""
    echo "Flags:"
    echo "  --release=<APP_RELEASE_VERSION>     required (e.g. v0.27.1)"
    echo ""
    echo "Example: ./build.sh --release=v0.27.1 --platform=linux/amd64"
    exit 1
fi

# (upstream installed yq here with sudo; nothing in this script ever calls it, and the
# build runner has no passwordless sudo — the install was the only thing that could fail)

cd $(dirname "$0")

string_replace(){
    local file="$1"
    local search="$2"
    local replace="$3"
    
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s|$search|$replace|g" "$file"
    else
        sed -i "s|$search|$replace|g" "$file"
    fi
}
remove_line(){
    local file="$1"
    local line="$2"

    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' '/'$line'/d' "$file"
    else
        sed -i '/'$line'/d' "$file"
    fi
}

update_env_file(){
    local file="$1"
    local key="$2"
    local value="$3"

    # if key is in file, replace it
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' 's|^'$key'=.*|'$key'='$value'|' "$file"
    else
        sed -i 's|^'$key'=.*|'$key'='$value'|' "$file"
    fi

    # if key not in file, add it
    if ! grep -q "^$key=" "$file"; then
        echo "$key=$value" >> "$file"
    fi
}

build_dist_files(){
    cp ./variables.env $DIST_DIR/plane.env
    cp ../../../apps/proxy/Caddyfile.aio.ce $DIST_DIR/Caddyfile

    echo "" >> $DIST_DIR/plane.env
    echo "" >> $DIST_DIR/plane.env

    # update the plane.env file with the APP_RELEASE_VERSION
    update_env_file $DIST_DIR/plane.env "APP_RELEASE_VERSION" "$APP_RELEASE_VERSION"
    update_env_file $DIST_DIR/plane.env "APP_RELEASE" "$APP_RELEASE_VERSION"
    update_env_file $DIST_DIR/plane.env "APP_VERSION" "$APP_RELEASE_VERSION"
    
    update_env_file $DIST_DIR/plane.env "API_BASE_URL" "http://localhost:3004"
    update_env_file $DIST_DIR/plane.env "SITE_ADDRESS" ":80"


    # print docker build command
    echo "------------------------------------------------"
    echo "Run the following command to build the image:"
    echo "------------------------------------------------"
    echo ""
    echo "docker build -t $IMAGE_NAME \\"
    echo "  -f $(pwd)/Dockerfile \\"
    echo "  --build-arg PLANE_VERSION=$APP_RELEASE_VERSION \\"
    echo "  $(pwd)"
    echo ""
    echo "------------------------------------------------"
}


main(){
    # check if the dist directory exists
    echo ""
    if [ -d "$DIST_DIR" ]; then
        echo "Cleaning existing dist directory..."
        rm -rf $DIST_DIR
    fi
    echo "Creating dist directory..." 
    mkdir -p $DIST_DIR
    echo ""

    build_dist_files
    if [ $? -ne 0 ]; then
        echo "Error: Failed to build docker image"
        exit 1
    fi
}

main "$@"

