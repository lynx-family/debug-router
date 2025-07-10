CURRENT_PATH=$(cd `dirname $0`; pwd)
DEBUG_ROUTER_ANDROID_NAME=("debug_router/android/debug_router")

for index in 0
do
    ROOT_DEBUG_ROUTER_JAVA_PATH=$CURRENT_PATH"/../../"${DEBUG_ROUTER_ANDROID_NAME[index]}"/src/main/java/"
    DEBUG_ROUTER_OUTPUT_DIR=$CURRENT_PATH"/../../debug_router/android/build/gen/"
    DEBUG_ROUTER_GEN_FILE=$CURRENT_PATH"/jni_generator.py"
    while read line
    do
        file_name=${line##*/}
        jni_file_name=${file_name%.*}"_jni.h"
        input_file=$ROOT_DEBUG_ROUTER_JAVA_PATH$line
        output_file=$DEBUG_ROUTER_OUTPUT_DIR$jni_file_name
        python $DEBUG_ROUTER_GEN_FILE $input_file $output_file
    echo "python $DEBUG_ROUTER_GEN_FILE $input_file $output_file"
    done < $CURRENT_PATH"/../../debug_router/android/build/jni_files"

done
